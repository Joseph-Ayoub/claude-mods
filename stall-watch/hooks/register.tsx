// stall-watch: retries a turn that died on a transient API error (capped,
// backed off), pins a usage-limit countdown, writes a resume note near the
// limit, and, opt-in per session, resumes once a usage limit resets.
//
// Why it is built this way:
// - turn.complete says only that a turn ended on an 'error'; classic.StopFailure
//   carries the error kind. The two are paired (either may arrive first) and
//   only a transient kind is retried, so billing, auth, invalid-request and
//   context-overflow failures are never re-run.
// - Every automated submit (retry or resume, one shared cap) is counted at its
//   call site (the plugin's own prompt.submit hook never sees its own submits)
//   and the counter resets only on the person's own prompt (composer, bridge
//   or sdk: isPerson), so a persistent error cannot loop. A submit another
//   hook drops is not counted.
// - Everything armed belongs to one conversation (`owner`). A /clear or an
//   in-process resume moves the process to another session id; whatever was
//   armed for the old one is forgotten, both at session.end and, should that
//   be missed, by the next event or timer that sees a different session id.
// - Everything armed waits on one failed turn. Once the session moves past it
//   (any main-loop turn starts, or one ends without an error), it is dropped;
//   the plugin's own turns start with nothing armed, as each fire clears its
//   plan before submitting. A failure kind or error turn still unpaired goes
//   with it, so it never decides a later turn. A prompt the person typed over
//   the failed turn runs next, so that failure arms nothing.
// - Timers die on hot reload and quit, so what they are for lives in $.state
//   (and the resume arm in $.store); session.start (which a reload fires
//   again) and each hook re-arm them.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { StallWatchErrorTurn, StallWatchPending, StallWatchResumeArm, StallWatchWindow } from '../types'
import {
  MAX_ATTEMPTS,
  NOTE_THRESHOLD,
  PAIR_WINDOW_MS,
  backoffSeconds,
  cleanWindows,
  clockText,
  exhaustedWindow,
  isContextOverflow,
  isPerson,
  isRetryable,
  isSafeId,
  parseOffset,
  parseTime,
  promptExcerpt,
  statusText,
  waitMs,
  windowText,
} from './format'

type $ = EngineInterface

const CONTINUE_TEXT =
  'The previous turn ended on a transient API error; continue from where you left off without restarting the work.'
const RESUME_TEXT =
  'The usage limit has reset; continue from where you left off without restarting the work.'

/** Store records older than this belong to sessions long gone. */
const STORE_TTL_MS = 14 * 24 * 3_600_000
/**
 * Resume notes hold prompt text, so they are kept for less time than the
 * store's switches: a week covers a weekly limit's reset.
 */
const NOTE_TTL_MS = 7 * 24 * 3_600_000
/** A reset is followed by this much slack before resuming. */
const RESUME_SLACK_MS = 30_000
/** The suggestion waits for the turn to have fully ended (it is refused mid-turn). */
const SUGGEST_DELAY_MS = 1_500

const FAILURE = { plugin: 'stall-watch', key: 'failure' } as const
const ERROR_TURN = { plugin: 'stall-watch', key: 'errorTurn' } as const
const ATTEMPTS = { plugin: 'stall-watch', key: 'attempts' } as const
const PENDING = { plugin: 'stall-watch', key: 'pending' } as const
const LAST_COMPOSER_AT = { plugin: 'stall-watch', key: 'lastComposerAt' } as const
const LAST_ORIGIN = { plugin: 'stall-watch', key: 'lastOrigin' } as const
const LAST_PROMPT = { plugin: 'stall-watch', key: 'lastPrompt' } as const
const WINDOWS = { plugin: 'stall-watch', key: 'windows' } as const
const IS_STATUS_SHOWN = { plugin: 'stall-watch', key: 'isStatusShown' } as const
const TZ_OFFSET = { plugin: 'stall-watch', key: 'tzOffsetMin' } as const
const RESUME_ENABLED = { plugin: 'stall-watch', key: 'resumeEnabled' } as const
const RESUME_ARM = { plugin: 'stall-watch', key: 'resumeArm' } as const
const NOTE_KEY = { plugin: 'stall-watch', key: 'noteKey' } as const
const OWNER = { plugin: 'stall-watch', key: 'owner' } as const
const COMPOSER_TURN = { plugin: 'stall-watch', key: 'composerTurnId' } as const

const failure = atom(FAILURE, null)
const errorTurn = atom(ERROR_TURN, null)
const attempts = atom(ATTEMPTS, 0)
const pending = atom(PENDING, null)
const lastComposerAt = atom(LAST_COMPOSER_AT, 0)
const lastOrigin = atom(LAST_ORIGIN, null)
const lastPrompt = atom(LAST_PROMPT, null)
const windows = atom(WINDOWS, [])
const isStatusShown = atom(IS_STATUS_SHOWN, false)
const tzOffset = atom(TZ_OFFSET, null)
const resumeEnabled = atom(RESUME_ENABLED, false)
const resumeArm = atom(RESUME_ARM, null)
const noteKey = atom(NOTE_KEY, null)
const owner = atom(OWNER, null)
const composerTurn = atom(COMPOSER_TURN, null)

/** What $.store keeps per session: never prompt text, only the resume switch. */
type StoreRecord = {
  sessionId: string
  enabled: boolean
  resetsAt?: string
  armedAt?: number
  updatedAt: number
}

const storeKey = (sessionId: string) => `session:${sessionId}`

function asRecord(value: unknown): StoreRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const r = value as Record<string, unknown>
  if (typeof r.sessionId !== 'string' || typeof r.enabled !== 'boolean') return undefined
  return {
    sessionId: r.sessionId,
    enabled: r.enabled,
    ...(typeof r.resetsAt === 'string' ? { resetsAt: r.resetsAt } : {}),
    ...(typeof r.armedAt === 'number' ? { armedAt: r.armedAt } : {}),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
  }
}

// Timer handles, and only those, are module-scoped: a hot reload cancels the
// timers together with this environment, so the handles die with them. What a
// timer was for lives in $.state, from which ensureTimers re-arms it.
const timers: { retry?: Timer; resume?: Timer; tick?: Timer; suggest?: Timer } = {}
/** Whether this environment has registered /stall-watch (a reload starts a new one). */
const registered = { isCommand: false }

function cancel(name: keyof typeof timers) {
  timers[name]?.cancel()
  timers[name] = undefined
}

async function persist(
  $: $,
  patch: Partial<Omit<StoreRecord, 'sessionId' | 'updatedAt'>>,
  drop: ('resetsAt' | 'armedAt')[] = [],
  forSession?: string,
) {
  const sessionId = forSession ?? (await $.session.id())
  const now = await $.clock.now()
  const prev = asRecord(await $.store.get(storeKey(sessionId)))
  const next: StoreRecord = { ...(prev ?? { enabled: false }), ...patch, sessionId, updatedAt: now }
  for (const field of drop) delete next[field]
  await $.store.set(storeKey(sessionId), next)
}

// ---- conversation ownership ---------------------------------------------

/**
 * Drops everything armed or counted for the conversation that just ended, so
 * nothing meant for it fires into the one the process moved on to. Usage
 * windows and the countdown are the account's, not the conversation's, and
 * stay.
 */
async function forgetConversation($: $) {
  cancel('retry')
  cancel('resume')
  cancel('suggest')
  await $.state.set(PENDING, null)
  await $.state.set(RESUME_ARM, null)
  await $.state.set(RESUME_ENABLED, false)
  await $.state.set(FAILURE, null)
  await $.state.set(ERROR_TURN, null)
  await $.state.set(ATTEMPTS, 0)
  await $.state.set(LAST_ORIGIN, null)
  await $.state.set(LAST_PROMPT, null)
  await $.state.set(NOTE_KEY, null)
  await $.state.set(COMPOSER_TURN, null)
}

/**
 * Whether the conversation the state belongs to is still the current one. A
 * different session id means a switch whose session.end was missed: the old
 * conversation's state is forgotten and the current one adopted.
 */
async function ensureOwner($: $): Promise<boolean> {
  const current = await $.session.id()
  const held = await read($, owner)
  if (held === current) return true
  if (held !== null) await forgetConversation($)
  await $.state.set(OWNER, current)
  return held === null
}

// ---- auto-retry ---------------------------------------------------------

function armRetry($: $, plan: StallWatchPending, now: number) {
  cancel('retry')
  timers.retry = $.clock.after(Math.max(0, plan.dueAt - now), () => {
    // Fails closed: nothing is sent, and a plan the failure left in $.state is
    // re-armed by the next session.start or hook, against the same cap.
    void fireRetry($, plan.armedAt).catch(() => undefined)
  })
}

async function fireRetry($: $, armedAt: number) {
  timers.retry = undefined
  // Armed for a conversation the process has since left: never fire into another.
  if (!(await ensureOwner($))) return
  let isMine = false
  await update($, pending, p => {
    isMine = p !== null && p.armedAt === armedAt
    return isMine ? null : p
  })
  if (!isMine) return
  // The person typed since this was armed: their prompt is the next turn.
  if ((await read($, lastComposerAt)) > armedAt) return
  const used = await read($, attempts)
  if (used >= MAX_ATTEMPTS) return
  await $.state.set(ATTEMPTS, used + 1)
  await $.state.set(LAST_ORIGIN, 'plugin')
  const sent = await $.prompt.submit({ text: CONTINUE_TEXT }).catch(() => undefined)
  if (sent === undefined || sent.drop !== undefined) {
    // Refused below us (another plugin or a settings hook): not an attempt,
    // and not re-armed, so a refusing guard cannot become a loop.
    await $.state.set(ATTEMPTS, used)
    $.ui.toast('stall-watch: auto-retry was not sent (refused)')
  }
}

/**
 * Acts on one paired failure of the main-loop turn `turnId`: retry, wait for a
 * reset, or leave it alone.
 */
async function decide($: $, kind: string, contextOverflow: boolean, now: number, turnId: string | undefined) {
  if (!isRetryable(kind, contextOverflow)) return
  // The person typed over the turn that failed: their prompt is queued to run
  // next (or went into that turn), and an automated continue would race it.
  if (turnId !== undefined && (await read($, composerTurn)) === turnId) return
  if (kind === 'rate_limit') {
    // An exhausted usage window (95 %+) cannot clear before its reset: backing
    // off for seconds would only spend the attempts, so none is spent. With no
    // exhausted window whose reset is ahead (none, unknown reset, stale
    // reading) it is retried as usual.
    const exhausted = exhaustedWindow(await read($, windows), now)
    if (exhausted !== undefined) {
      await armResumeFor($, exhausted, now)
      return
    }
  }
  const used = await read($, attempts)
  if (used >= MAX_ATTEMPTS) {
    $.ui.toast(`stall-watch: auto-retry stopped after ${MAX_ATTEMPTS}/${MAX_ATTEMPTS}`)
    return
  }
  const attempt = used + 1
  const seconds = backoffSeconds(attempt)
  const plan: StallWatchPending = { dueAt: now + seconds * 1000, attempt, armedAt: now }
  let isArmed = false
  await update($, pending, p => {
    isArmed = p === null
    return p ?? plan
  })
  if (!isArmed) return
  armRetry($, plan, now)
  $.ui.toast(`stall-watch: auto-retry ${attempt}/${MAX_ATTEMPTS} in ${seconds}s`)
}

// ---- resume after a usage-limit reset (opt-in) --------------------------

function armResume($: $, arm: StallWatchResumeArm, now: number) {
  cancel('resume')
  timers.resume = $.clock.after(waitMs(arm.dueAt, now), () => {
    timers.resume = undefined
    void (async () => {
      const at = await $.clock.now()
      if (at < arm.dueAt) {
        // One step of a long wait: wait on, if this arm still stands.
        if ((await read($, resumeArm))?.armedAt === arm.armedAt) armResume($, arm, at)
        return
      }
      await fireResume($, arm.armedAt)
    })().catch(() => undefined)
  })
}

/** `window` is exhaustedWindow's answer: full, with a reset still ahead. */
async function armResumeFor($: $, window: StallWatchWindow, now: number) {
  if (!(await read($, resumeEnabled))) {
    $.ui.toast('stall-watch: usage limit reached; /stall-watch on resumes after the reset')
    return
  }
  const resetMs = parseTime(window.resetsAt)
  if (resetMs === null || window.resetsAt === undefined || resetMs <= now) return
  if ((await read($, attempts)) >= MAX_ATTEMPTS) {
    $.ui.toast(`stall-watch: resume stopped after ${MAX_ATTEMPTS}/${MAX_ATTEMPTS}`)
    return
  }
  const arm: StallWatchResumeArm = { resetsAt: window.resetsAt, dueAt: resetMs + RESUME_SLACK_MS, armedAt: now }
  await $.state.set(RESUME_ARM, arm)
  armResume($, arm, now)
  await persist($, { enabled: true, resetsAt: arm.resetsAt, armedAt: arm.armedAt })
  const offset = await read($, tzOffset)
  const when = offset === null ? 'after the reset' : `at ${clockText(arm.dueAt, now, offset)}`
  $.ui.toast(`stall-watch: will resume ${when}`)
}

async function fireResume($: $, armedAt: number) {
  if (!(await ensureOwner($))) return
  let isMine = false
  await update($, resumeArm, a => {
    isMine = a !== null && a.armedAt === armedAt
    return isMine ? null : a
  })
  if (!isMine) return
  await persist($, {}, ['resetsAt', 'armedAt'])
  if (!(await read($, resumeEnabled))) return
  if ((await read($, lastComposerAt)) > armedAt) return
  // One cap for retries and resumes: at most MAX_ATTEMPTS automated turns per prompt of the person's.
  const used = await read($, attempts)
  if (used >= MAX_ATTEMPTS) return
  await $.state.set(ATTEMPTS, used + 1)
  await $.state.set(LAST_ORIGIN, 'plugin')
  const sent = await $.prompt.submit({ text: RESUME_TEXT }).catch(() => undefined)
  if (sent === undefined || sent.drop !== undefined) {
    await $.state.set(ATTEMPTS, used)
    $.ui.toast('stall-watch: resume was not sent (refused)')
  }
}

async function disarmResume($: $) {
  cancel('resume')
  await $.state.set(RESUME_ARM, null)
  await persist($, {}, ['resetsAt', 'armedAt'])
}

/**
 * The session moved past the failed turn: a main-loop turn started (a task
 * notification, a peer's prompt, a scheduled one, the engine's own
 * continuation) or a turn ended without an error. A retry or resume still
 * waiting for that failure would now fire into a session that went on without
 * it, so both are dropped. The plugin's own turns reach here with nothing
 * armed (fireRetry and fireResume clear theirs before submitting), so its own
 * submits need no telling apart. Should this turn fail too, its own failure
 * arms afresh, against the same cap.
 */
async function supersede($: $) {
  cancel('retry')
  if ((await read($, pending)) !== null) await $.state.set(PENDING, null)
  if ((await read($, resumeArm)) !== null) await disarmResume($)
  // A failure kind or an error turn still waiting for its other half belongs
  // to the turn the session moved past. Paired with the next turn's error, it
  // would decide that turn by the wrong kind (a billing_error retried as
  // 'overloaded'), or arm a retry while another turn runs.
  if ((await read($, failure)) !== null) await $.state.set(FAILURE, null)
  if ((await read($, errorTurn)) !== null) await $.state.set(ERROR_TURN, null)
}

// ---- status line --------------------------------------------------------

/** Draws (or clears) the countdown from `list`; the minute ticker runs only while shown. */
async function drawStatus($: $, list: readonly StallWatchWindow[], wasShown: boolean) {
  const now = await $.clock.now()
  const text = statusText(list, now, await read($, tzOffset))
  if (text !== undefined) {
    $.ui.status(text)
    if (!wasShown) await $.state.set(IS_STATUS_SHOWN, true)
    if (timers.tick === undefined) startTick($)
    return
  }
  cancel('tick')
  if (wasShown) {
    $.ui.status(undefined)
    await $.state.set(IS_STATUS_SHOWN, false)
  }
}

function startTick($: $) {
  timers.tick = $.clock.every(60_000, () => {
    void (async () => {
      await drawStatus($, await read($, windows), await read($, isStatusShown))
    })().catch(() => cancel('tick'))
  })
}

// ---- resume note --------------------------------------------------------

async function maybeWriteNote($: $, list: readonly StallWatchWindow[], now: number) {
  const top = list
    .filter(w => w.percentUsed >= NOTE_THRESHOLD)
    .sort((a, b) => b.percentUsed - a.percentUsed)[0]
  if (top === undefined) return
  const key = `${top.kind}|${top.resetsAt ?? ''}`
  if ((await read($, noteKey)) === key) return
  // Claimed before the write, so a burst of measurements writes once.
  await $.state.set(NOTE_KEY, key)
  const home = await $.env.get('HOME')
  const sessionId = await $.session.id()
  if (home === undefined || home === '' || !isSafeId(sessionId)) return
  const cwd = await $.session.cwd()
  const branch = await $.process
    .run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 5_000 })
    .then(r => (r.exitCode === 0 ? r.stdout.trim() || 'unknown' : 'unknown'))
    .catch(() => 'unknown')
  const offset = await read($, tzOffset)
  const prompt = await read($, lastPrompt)
  const written =
    offset === null
      ? `${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : `${new Date(now + offset * 60_000).toISOString().slice(0, 10)} ${clockText(now, now, offset)} (local)`
  const lines = [
    '# stall-watch resume note',
    '',
    `- session: ${sessionId}`,
    `- written: ${written}`,
    `- branch: ${branch}`,
    `- cwd: ${cwd}`,
    `- limit: ${windowText(top, now, offset)}`,
    '',
    '## Last prompt',
    '',
    // Held as an excerpt already; cut again in case $.state predates that (a reload keeps it).
    prompt === null ? '(none captured this session)' : promptExcerpt(prompt),
    '',
    `Resume with: claude --resume ${sessionId}`,
    '',
  ]
  await $.fs.write(`${home}/.claude/stall-watch/${sessionId}.md`, lines.join('\n')).catch(() => {
    $.ui.toast('stall-watch: could not write the resume note')
  })
}

/**
 * Data minimisation: deletes this mod's resume notes older than NOTE_TTL_MS.
 * Only regular `<session id>.md` files in its own folder are touched; there is
 * no $.fs delete, so it runs /bin/rm by argv (no shell).
 */
async function pruneNotes($: $, now: number) {
  const home = await $.env.get('HOME')
  if (home === undefined || home === '') return
  const dir = `${home}/.claude/stall-watch`
  const entries = await $.fs.list(dir).catch(() => [])
  const stale = entries.filter(
    entry =>
      entry.kind === 'file' &&
      !entry.isLink &&
      entry.name.endsWith('.md') &&
      isSafeId(entry.name.slice(0, -3)) &&
      entry.mtimeMs > 0 &&
      now - entry.mtimeMs > NOTE_TTL_MS,
  )
  // A handful per start keeps session.start inside its hook budget; the rest go next time.
  for (const entry of stale.slice(0, 20)) {
    await $.process.run(['/bin/rm', '-f', '--', `${dir}/${entry.name}`], { timeoutMs: 3_000 }).catch(() => undefined)
  }
}

// ---- lazy re-arm after a hot reload -------------------------------------

/**
 * Registers /stall-watch once per environment: at session.start (which a
 * reload or worker respawn fires again), and lazily at any other hook, should
 * that session.start have failed.
 */
async function ensureCommand($: $) {
  if (registered.isCommand) return
  registered.isCommand = true
  await $.command
    .register({
      name: 'stall-watch',
      description: 'Resume this session after a usage-limit reset: on, off or status.',
      argumentHint: 'on|off|status',
      immediate: true,
    })
    .catch(() => {
      registered.isCommand = false
    })
}

async function ensureTimers($: $) {
  await ensureOwner($)
  await ensureCommand($)
  const now = await $.clock.now()
  const plan = await read($, pending)
  if (plan !== null && timers.retry === undefined) armRetry($, plan, now)
  const arm = await read($, resumeArm)
  if (arm !== null && timers.resume === undefined && (await read($, resumeEnabled))) armResume($, arm, now)
  if (timers.tick === undefined && (await read($, isStatusShown))) startTick($)
}

export const register: Register = on => {
  // ---- hooks --------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await ensureOwner($)
    await ensureCommand($)

    const zone = await $.process.run(['date', '+%z'], { timeoutMs: 3_000 }).catch(() => undefined)
    await $.state.set(TZ_OFFSET, zone !== undefined && zone.exitCode === 0 ? parseOffset(zone.stdout) : null)

    const now = await $.clock.now()
    const sessionId = await $.session.id()
    const record = asRecord(await $.store.get(storeKey(sessionId)))
    // Seen again: refreshed, so another session's pruning below never takes
    // the switch of a session that is still in use.
    if (record !== undefined) await persist($, {}).catch(() => undefined)
    if (record?.enabled === true) {
      await $.state.set(RESUME_ENABLED, true)
      const resetMs = parseTime(record.resetsAt)
      if (record.resetsAt !== undefined && resetMs !== null && resetMs + RESUME_SLACK_MS > now) {
        const arm: StallWatchResumeArm = {
          resetsAt: record.resetsAt,
          dueAt: resetMs + RESUME_SLACK_MS,
          armedAt: record.armedAt ?? now,
        }
        await $.state.set(RESUME_ARM, arm)
        armResume($, arm, now)
      } else if (record.resetsAt !== undefined) {
        // The reset passed while no session was running: the person is here
        // now, so it is theirs to continue, not ours.
        await persist($, {}, ['resetsAt', 'armedAt'])
      }
    }

    // A reload or worker respawn fires session.start again and its timers are
    // gone: re-arm a pending retry, an armed resume and the minute ticker from
    // $.state now rather than at the next event. Before the pruning below,
    // which is the slow part.
    await ensureTimers($)

    // Data minimisation: forget switches of sessions long gone.
    const keys = await $.store.keys().catch(() => [] as string[])
    for (const key of keys.filter(k => k.startsWith('session:')).slice(0, 200)) {
      const r = asRecord(await $.store.get(key))
      if (r === undefined || now - r.updatedAt > STORE_TTL_MS) await $.store.delete(key)
    }
    await pruneNotes($, now)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    // The process ends with the session ('prompt_input_exit', 'other'): its
    // timers die with it, and the stored arm is kept for a restart of the same
    // session. Any other reason ('clear', 'resume', 'logout', or one this
    // build does not know) moves the process on to another conversation, into
    // which nothing armed for this one may fire.
    if (e.reason !== 'prompt_input_exit' && e.reason !== 'other') {
      // A command is registered for the session it was registered in: the
      // next hook registers it again for the one the process moved on to
      // (registering a name again replaces it).
      registered.isCommand = false
      await forgetConversation($)
      await $.state.set(OWNER, null)
      if (e.reason === 'clear') {
        await $.store.delete(storeKey(e.sessionId)).catch(() => undefined)
      } else if (asRecord(await $.store.get(storeKey(e.sessionId)).catch(() => undefined)) !== undefined) {
        // Left, not wiped: keep the switch for a later --resume, drop the arm.
        await persist($, {}, ['resetsAt', 'armedAt'], e.sessionId).catch(() => undefined)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Observer: never refuses a prompt, so a failure replays next(e) (fail open).
  on('prompt.submit', async ($, e, next) => {
    await ensureOwner($)
    const kind = e.origin?.kind ?? 'unclassified'
    const isOwn = isPerson(kind)
    if (isOwn) {
      // The person is back: their prompt supersedes anything armed, and the
      // runaway cap starts over. Done before ensureTimers, which after a hot
      // reload would otherwise re-arm an overdue retry to fire beside it.
      cancel('retry')
      await $.state.set(LAST_COMPOSER_AT, await $.clock.now())
      await $.state.set(PENDING, null)
      await $.state.set(ATTEMPTS, 0)
      // Typed over a running turn: should that turn fail, this prompt runs
      // next, so decide() leaves that failure alone.
      if (e.turnId !== undefined) await $.state.set(COMPOSER_TURN, e.turnId)
      // Only a redacted excerpt is ever held, never the raw prompt.
      await $.state.set(LAST_PROMPT, promptExcerpt(e.text))
      if ((await read($, resumeArm)) !== null) await disarmResume($)
    }
    if (isOwn || e.turnId !== undefined) {
      await ensureTimers($)
    } else {
      // Another origin's prompt starts a turn of its own, whose turn.start
      // drops whatever is armed. Re-arming an overdue plan here would let it
      // fire before that turn starts, so the re-arm waits for that turn.start.
      await ensureCommand($)
    }
    // A prompt typed or delivered into a running turn starts no turn of its own.
    if (e.turnId === undefined) await $.state.set(LAST_ORIGIN, kind)
    // While resume is on, the person's prompt keeps the stored switch fresh
    // against another session's pruning (and restores it, should that have run).
    if (isOwn && (await read($, resumeEnabled))) await persist($, { enabled: true }).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.StopFailure', async ($, e, next) => {
    if (e.agent_id === undefined) {
      await ensureTimers($)
      const now = await $.clock.now()
      const kind = String(e.error)
      const overflow = isContextOverflow(e.error_details)
      // turn.complete may have arrived first: pair with it here.
      const found: { turn: StallWatchErrorTurn | null } = { turn: null }
      await update($, errorTurn, t => {
        found.turn = t !== null && now - t.at <= PAIR_WINDOW_MS ? t : null
        return found.turn === null ? t : null
      })
      await $.state.set(FAILURE, { at: now, kind, isContextOverflow: overflow, isHandled: found.turn !== null })
      if (found.turn !== null) await decide($, kind, overflow, now, found.turn.turnId)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Observer, main loop only (a subagent's run raises no turn.start).
  on('turn.start', async ($, e, next) => {
    // Ownership first, so a missed session switch forgets the old state rather
    // than disarming into the new session's store record. Then dropped before
    // re-arming: re-arming first would let an overdue plan fire beside this turn.
    await ensureOwner($)
    await supersede($)
    await ensureTimers($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await ensureTimers($)
    const now = await $.clock.now()
    if (e.reason === 'error') {
      let paired: { kind: string; isContextOverflow: boolean } | null = null
      await update($, failure, f => {
        paired = f !== null && !f.isHandled && now - f.at <= PAIR_WINDOW_MS ? f : null
        return paired === null ? f : { ...f!, isHandled: true }
      })
      if (paired === null) {
        // StopFailure may still be on its way: leave the turn for it to pair.
        await $.state.set(ERROR_TURN, { at: now, turnId: e.turnId })
      } else {
        const { kind, isContextOverflow: overflow } = paired as { kind: string; isContextOverflow: boolean }
        await decide($, kind, overflow, now, e.turnId)
      }
    } else {
      // Answered or interrupted: the session is past the failed turn. Normally
      // turn.start already dropped what was armed; this covers a missed one.
      await supersede($)
    }
    if (e.reason === 'answer') {
      if ((await read($, lastOrigin)) === 'task-notification') {
        await $.state.set(LAST_ORIGIN, null)
        // A hint only (Tab to accept); never submitted on the person's behalf.
        cancel('suggest')
        timers.suggest = $.clock.after(SUGGEST_DELAY_MS, () => {
          timers.suggest = undefined
          void $.prompt.suggest({ text: 'resume' }).catch(() => undefined)
        })
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await ensureTimers($)
    const list = cleanWindows(e.rateLimits)
    // An empty reading (off a subscription, before the first response) is no news.
    if (list.length > 0) {
      await $.state.set(WINDOWS, list)
      await drawStatus($, list, await read($, isStatusShown))
      await maybeWriteNote($, list, await $.clock.now())
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'stall-watch' }, async ($, e) => {
    await ensureTimers($)
    const arg = e.args.trim().toLowerCase()
    const now = await $.clock.now()
    if (arg === 'on' && !isPerson(e.origin?.kind)) {
      // Turning on is consent to automated submits: the person's alone (composer,
      // bridge or sdk), never another plugin's or a peer's. Off and status are safe from anyone.
      return { text: 'stall-watch: only you can turn resume on (type /stall-watch on).' }
    }
    if (arg === 'on') {
      await $.state.set(RESUME_ENABLED, true)
      await persist($, { enabled: true })
      // Turned on after the limit already hit: arm for the pending reset now.
      const last = await read($, failure)
      const exhausted = exhaustedWindow(await read($, windows), now)
      if (last?.kind === 'rate_limit' && exhausted !== undefined && exhausted.resetsAt !== undefined) {
        const resetMs = parseTime(exhausted.resetsAt)
        if (resetMs !== null && resetMs > now && (await read($, attempts)) < MAX_ATTEMPTS) {
          const arm: StallWatchResumeArm = { resetsAt: exhausted.resetsAt, dueAt: resetMs + RESUME_SLACK_MS, armedAt: now }
          await $.state.set(RESUME_ARM, arm)
          armResume($, arm, now)
          await persist($, { enabled: true, resetsAt: arm.resetsAt, armedAt: arm.armedAt })
          return { text: 'stall-watch: resume after reset is ON; armed for the current limit.' }
        }
      }
      return { text: 'stall-watch: resume after reset is ON for this session.' }
    }
    if (arg === 'off') {
      await $.state.set(RESUME_ENABLED, false)
      cancel('resume')
      await $.state.set(RESUME_ARM, null)
      await persist($, { enabled: false }, ['resetsAt', 'armedAt'])
      return { text: 'stall-watch: resume after reset is OFF for this session.' }
    }
    if (arg === '' || arg === 'status') {
      const enabled = await read($, resumeEnabled)
      const arm = await read($, resumeArm)
      const plan = await read($, pending)
      const offset = await read($, tzOffset)
      const at = (ms: number) => (offset === null ? new Date(ms).toISOString() : clockText(ms, now, offset))
      const lines = [
        `stall-watch: resume after reset is ${enabled ? 'ON' : 'OFF'}.`,
        `Automated continues used: ${await read($, attempts)}/${MAX_ATTEMPTS}.`,
        plan === null ? 'No retry pending.' : `Retry ${plan.attempt}/${MAX_ATTEMPTS} at ${at(plan.dueAt)}.`,
        arm === null ? 'No resume armed.' : `Resume armed for ${at(arm.dueAt)}.`,
      ]
      return { text: lines.join('\n') }
    }
    return { text: 'Usage: /stall-watch on | off | status' }
  }).catch(() => ({ text: 'stall-watch: the command failed; run /stall-watch status to see what stands.' }))
}
