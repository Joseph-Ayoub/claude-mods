// The cockpit band: one plugin that owns the band above the prompt, because
// AbovePrompt is a single instance shared with surveys and every other band
// mod. It draws quick replies, the branch/PR/CI standing line, decision cards
// parsed from the last answer, "waiting on you" items and a standing-rule
// capture prompt, each section folding to its toggle.
//
// Everything a drawing reads lives in $.state (it survives a hot reload); the
// only module variables are the timer's armed flag and the in-flight promises,
// all of which are meant to reset when the module reloads.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderSurface } from 'claude-code'

import type { CockpitBackground, CockpitCards, CockpitCollapsed, CockpitHost, CockpitPr, CockpitRule, CockpitStanding, CockpitWaiting } from '../types'
import {
  answersText,
  archiveReason,
  completion,
  fillOutcome,
  findRuleSentence,
  hasRule,
  insertCapturedRule,
  labelMarksRecommended,
  normalizePrompt,
  normalizeRule,
  parseDecisions,
  parsePr,
  parseWaiting,
  promptPreview,
  sha256Hex,
  standingLine,
  stripFences,
  personText,
} from './parse'

type Engine = EngineInterface

const PENDING = { plugin: 'cockpit', key: 'pending' } as const
const RECENT = { plugin: 'cockpit', key: 'recent' } as const
const STANDING = { plugin: 'cockpit', key: 'standing' } as const
const LAST_TOOL_AT = { plugin: 'cockpit', key: 'lastToolAt' } as const
const CARDS = { plugin: 'cockpit', key: 'cards' } as const
const WAITING = { plugin: 'cockpit', key: 'waiting' } as const
const RULE = { plugin: 'cockpit', key: 'rule' } as const
const COLLAPSED = { plugin: 'cockpit', key: 'collapsed' } as const
const LAST_REPORT_AT = { plugin: 'cockpit', key: 'lastReportAt' } as const
const BACKGROUND = { plugin: 'cockpit', key: 'background' } as const
const HOST = { plugin: 'cockpit', key: 'host' } as const

const pending = atom(PENDING, null)
const standing = atom(STANDING, null)
const lastToolAt = atom(LAST_TOOL_AT, 0)
const cards = atom(CARDS, null)
const waiting = atom(WAITING, [])
const rule = atom(RULE, null)
const collapsed = atom(COLLAPSED, { replies: false, standing: false, cards: false, waiting: false, rule: false })
const lastReportAt = atom(LAST_REPORT_AT, 0)
const background = atom(BACKGROUND, null)
const host = atom(HOST, { archiveTool: false, lead: null, leadState: 'unknown' })
const recent = atom(RECENT, [])

const REFRESH_MS = 60_000
const PROCESS_TIMEOUT_MS = 10_000
/** The desktop app's session tools, reached through $.mcp.call; the archive ends this session. */
const HOST_SERVER = 'ccd_session_mgmt'
const ARCHIVE_TOOL = 'archive_session'
const ARCHIVE_TOOL_FULL = 'mcp__ccd_session_mgmt__archive_session'
const GET_SESSION_TOOL = 'get_session'
/** Tool calls that tell another session something: a report to the lead counts from the last one. */
const REPORT_TOOLS = new Set(['SendMessage', 'mcp__ccd_session_mgmt__send_message'])
const DUPLICATE_WINDOW_MS = 10 * 60_000
const RECENT_LIMIT = 5
// A pending reply whose submit continuation was lost (a reload mid-flight) must not block the button forever.
const PENDING_EXPIRY_MS = 10 * 60_000
// Idle is shown in minutes, so stamping more often than this only churns redraws.
const ACTIVITY_STAMP_MS = 15_000
const REFILL_DELAY_MS = 250
const PR_FIELDS = 'number,state,mergeable,mergeStateStatus,statusCheckRollup,mergedAt,headRefOid,url'
// $.process.run inherits the Claude process's PATH, not the login shell's, so a desktop-launched session may need these.
const GH_CANDIDATES = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'] as const
// One $.store key per saved rule and file, so two sessions saving at once never overwrite each other's
// record (the store has no compare-and-swap); a set of a fixed key is idempotent.
const capturedKey = (digest: string) => `capturedRule:${digest}`
const GLOBAL_PREAMBLE =
  '# Captured rules\n\nStanding rules captured from your prompts by the cockpit mod. Load them in every session with a line `@captured-rules.md` in ~/.claude/CLAUDE.md.\n\n'
// The import line ~/.claude/CLAUDE.md needs for the global file to load: relative, home-relative or absolute.
const GLOBAL_IMPORT = /(?:^|\s)@(?:~\/\.claude\/|\.\/|\/\S*\/\.claude\/)?captured-rules\.md(?=\s|$)/m
// The people a prompt can come from: what retires the cards and the waiting list. A notification,
// a peer or a schedule arriving between Claude's question and the answer is not the answer. `sdk` is
// the person too: the desktop app hosts its sessions over the SDK, so its typed prompts arrive so.
const PERSON_KINDS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])
// A $.process.run that rejects after this long timed out (it started); sooner, it could not start.
const TIMEOUT_GUESS_MS = PROCESS_TIMEOUT_MS / 2

// `id` keys the button; `hotkey` is set only on the harmless replies (see the note on REPLIES).
type Reply = { id: string; hotkey?: string; label: string; option: string; fallback: string }

// After any click on the band it holds the keys (claude-code.d.ts ButtonProps.hotkey), so the
// person's next typed letter presses a band Button with that hotkey, and a press does not say whether
// it was a click or a key. So only the harmless replies, Try again and Status, carry a hotkey, and
// letters only, since a bare digit typed into an empty composer presses a band Button with that digit.
// Go, Resume and Session completion set work in motion (Session completion can end in a merge and an
// archive, outward and hard to undo), so they send only on an explicit press of the button:
// "make sure..." typed into the band sends nothing.
const REPLIES: readonly Reply[] = [
  { id: 'g', label: 'Go', option: 'replyGo', fallback: 'Go ahead.' },
  { id: 'r', label: 'Resume', option: 'replyResume', fallback: 'Resume from where you left off; do not restart from scratch.' },
  { id: 't', hotkey: 't', label: 'Try again', option: 'replyTryAgain', fallback: 'Try again.' },
  {
    id: 's',
    hotkey: 's',
    label: 'Status',
    option: 'replyStatus',
    fallback: 'Status update: what ran and passed, what is merged, what is pending, and the link where it can be seen.',
  },
  {
    id: 'c',
    label: 'Session completion',
    option: 'replyCompletion',
    fallback:
      'Is everything done, completed and merged on green CI in this session, and communicated back to the lead session if there is one? If so, archive this session to wrap up; or is that already done?',
  },
]

// A phrase set in the options goes out as the person's words, so it is cleaned like any such text
// (personText) and the band shows it whenever it differs from the default (see the band hook).
const replyText = (options: PluginOptions, reply: Reply): string => {
  const value = options[reply.option]
  const text = typeof value === 'string' ? personText(value) : ''

  return text !== '' ? text : reply.fallback
}

// Timers die with the module on a hot reload, and this flag dies with them: the
// first event after a reload finds it false and arms a fresh timer.
let isArmed = false
// Set by any caller that saw a band surface itself, read by an arm already waiting on the roster:
// the roster it asked for may predate the attach that brought the surface.
let isBandSeen = false
let arming: Promise<void> | null = null
let refreshing: Promise<void> | null = null
// A refresh asked for while one runs: the running one's readings may predate what asked, so one more follows it.
let refreshQueued = false
// Main-loop Stops this load, so a refresh can say which Stop it followed; a reload restarts it and any old standing mismatches.
let stopSeq = 0
// This load's own mark on every Stop: a standing saved by an earlier load never matches a Stop of this one.
const loadToken = `${Math.floor(Math.random() * 0x7fffffff).toString(36)}-${Math.floor(Math.random() * 0x7fffffff).toString(36)}`
let hostLooking: Promise<void> | null = null
let ghBinary: string | null = null

const isBandSurface = (surface: RenderSurface | null | undefined): boolean => surface === 'terminal' || surface === 'desktop'

/**
 * Starts the minute timer once a surface that draws the band is attached.
 * Whether one is comes from the session's roster, not from `isInteractive`
 * (false for the desktop app's SDK-hosted session, which does draw the band),
 * and is asked again on each event until it is: a -p run never polls, even
 * after a hot reload, and a desktop that attaches later starts it.
 * `isKnown` skips the roster when the caller already saw a band surface.
 */
function arm($: Engine, isKnown = false): Promise<void> {
  if (isArmed) {
    return Promise.resolve()
  }

  isBandSeen ||= isKnown

  arming ??= (async () => {
    try {
      const surfaces = isBandSeen ? [] : await $.session.surfaces().catch(() => [] as readonly RenderSurface[])

      if (isArmed || !(isBandSeen || surfaces.some(isBandSurface))) {
        return
      }

      isArmed = true
      $.clock.every(REFRESH_MS, () => {
        void refresh($)
      })
      void refresh($)
    } finally {
      arming = null
    }
  })()

  return arming
}

/**
 * One coalesced standing refresh. A second caller while one runs shares it;
 * with `fresh`, it waits for the running one and reads again, since the
 * running one's git readings may predate what asked (a turn's end, an archive).
 * Never throws.
 */
function refresh($: Engine, fresh = false): Promise<void> {
  if (refreshing !== null) {
    if (!fresh) return refreshing
    refreshQueued = true
    const running = refreshing
    return running.then(() => (refreshing !== null ? refreshing : refresh($)))
  }

  refreshing = (async () => {
    try {
      const looked = await lookStanding($)
      const previous = (await $.state.get(STANDING)).value
      // The merge is dated from the refresh that first saw it, kept only while the same PR on the
      // same branch stays merged: another PR, or another branch, is a new merge to tell the lead about.
      const samePr =
        previous?.pr?.isMerged === true &&
        looked.pr !== null &&
        previous.pr.number === looked.pr.number &&
        previous.branch === looked.branch &&
        typeof previous.mergedSeenAt === 'number'
      looked.mergedSeenAt = looked.pr?.isMerged === true ? (looked.pr.mergedAt ?? (samePr ? previous.mergedSeenAt : looked.refreshedAt)) : null
      // With no PR, "merged" is HEAD in the default branch: dated from the refresh that first saw it, on this branch.
      const sameInDefault = previous?.inDefault === true && previous.branch === looked.branch && typeof previous.inDefaultSeenAt === 'number'
      looked.inDefaultSeenAt = looked.inDefault === true ? (sameInDefault ? previous.inDefaultSeenAt : looked.refreshedAt) : null
      await $.state.set(STANDING, looked)
      void lookHost($)
    } catch {
      // The line keeps its last value and turns "(stale Nm)" on its own.
    } finally {
      refreshing = null
      if (refreshQueued) {
        refreshQueued = false
        void refresh($)
      }
    }
  })()

  return refreshing
}

async function lookStanding($: Engine): Promise<CockpitStanding> {
  // Stamped before any reading: the standing is as old as its oldest reading, never younger, and
  // belongs to the Stop that stood when it started.
  const startedAt = await $.clock.now()
  const stopped = await read($, background)
  const stoppedAt = stopped?.seq ?? -1
  const stoppedToken = stopped?.token ?? ''
  // The session's own directory: in a worktree, repo().root is the main checkout and would always say "main".
  const cwd = await $.session.cwd()
  const git = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: PROCESS_TIMEOUT_MS }).catch(() => null)

  // git that cannot start (no $.process on this host, or a hang) is not the same as "not a repository".
  if (git === null) {
    return { branch: null, pr: null, prStatus: 'unavailable', refreshedAt: startedAt, isClean: null, dirtyFiles: null, headSha: null, aheadOfUpstream: null, hasRemote: null, defaultBranch: null, inDefault: null, mergedSeenAt: null, stopSeq: stoppedAt, stopToken: stoppedToken, inDefaultSeenAt: null }
  }

  const branch = git.exitCode === 0 ? git.stdout.trim() || null : null

  if (branch === null) {
    return { branch: null, pr: null, prStatus: 'skipped', refreshedAt: startedAt, isClean: null, dirtyFiles: null, headSha: null, aheadOfUpstream: null, hasRemote: null, defaultBranch: null, inDefault: null, mergedSeenAt: null, stopSeq: stoppedAt, stopToken: stoppedToken, inDefaultSeenAt: null }
  }

  // Clean means nothing to commit; a git that cannot say leaves it unknown (never "clean").
  const status = await $.process.run(['git', 'status', '--porcelain'], { cwd, timeoutMs: PROCESS_TIMEOUT_MS }).catch(() => null)
  const dirtyFiles = status !== null && status.exitCode === 0 ? status.stdout.split('\n').filter(line => line.trim() !== '').length : null
  const isClean = dirtyFiles === null ? null : dirtyFiles === 0

  // HEAD and what is ahead of its upstream: a merged PR counts only at this exact head, and with
  // no PR nothing may be unpushed. No upstream, or a git that cannot say, stays unknown.
  const head = await $.process.run(['git', 'rev-parse', 'HEAD'], { cwd, timeoutMs: PROCESS_TIMEOUT_MS }).catch(() => null)
  const headSha = head !== null && head.exitCode === 0 && /^[0-9a-f]{7,64}$/i.test(head.stdout.trim()) ? head.stdout.trim().toLowerCase() : null
  const ahead = await $.process.run(['git', 'rev-list', '--count', '@{u}..HEAD'], { cwd, timeoutMs: PROCESS_TIMEOUT_MS }).catch(() => null)
  const aheadOfUpstream = ahead !== null && ahead.exitCode === 0 && /^\d+$/.test(ahead.stdout.trim()) ? Number(ahead.stdout.trim()) : null

  // Any remote at all? None means nowhere to push or merge: a clean tree is as done as it gets.
  const remotes = await $.process.run(['git', 'remote'], { cwd, timeoutMs: PROCESS_TIMEOUT_MS }).catch(() => null)
  const hasRemote = remotes !== null && remotes.exitCode === 0 ? remotes.stdout.trim() !== '' : null

  // The remote default branch and whether HEAD is already in it: with no PR, that is what "merged" means.
  const symbolic = await $.process.run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd, timeoutMs: PROCESS_TIMEOUT_MS }).catch(() => null)
  const defaultBranch = symbolic !== null && symbolic.exitCode === 0 && /^[\w./-]+$/.test(symbolic.stdout.trim()) ? symbolic.stdout.trim() : null
  let inDefault: boolean | null = null
  if (defaultBranch !== null) {
    const contained = await $.process.run(['git', 'merge-base', '--is-ancestor', 'HEAD', defaultBranch], { cwd, timeoutMs: PROCESS_TIMEOUT_MS }).catch(() => null)
    inDefault = contained === null ? null : contained.exitCode === 0 ? true : contained.exitCode === 1 ? false : null
  }

  const found = await lookPr($, cwd)

  return { branch, ...found, refreshedAt: startedAt, isClean, dirtyFiles, headSha, aheadOfUpstream, hasRemote, defaultBranch, inDefault, mergedSeenAt: null, stopSeq: stoppedAt, stopToken: stoppedToken, inDefaultSeenAt: null }
}

/**
 * What the host can tell the band, re-read with every refresh (a server may
 * connect later): whether the app's archive tool is listed, and this session's
 * parent (lead) session, from the app's own record. A host that answers
 * nothing leaves "no lead" and "no archive tool": the button never shows on a
 * guess. Never throws.
 */
function lookHost($: Engine): Promise<void> {
  if (hostLooking !== null) return hostLooking
  hostLooking = (async () => {
    try {
      const held = await read($, host)
      const tools = await $.tool.list().catch(() => [])
      const archiveTool = tools.some(t => t.name === ARCHIVE_TOOL_FULL)
      let lead = held.lead
      let leadState = held.leadState
      if (tools.some(t => t.name === `mcp__${HOST_SERVER}__${GET_SESSION_TOOL}`)) {
        const timeout = new Promise<null>(resolve => {
          $.clock.after(PROCESS_TIMEOUT_MS, () => resolve(null))
        })
        const res = await Promise.race([$.mcp.call(HOST_SERVER, GET_SESSION_TOOL, { session_id: 'self' }).catch(() => null), timeout])
        const text = res && !res.isError ? res.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('') : ''
        const read = parentOf(text)
        // A failed or unreadable answer leaves what was known: a lead once seen is never forgotten.
        if (read !== null) {
          lead = read.lead
          leadState = read.lead === null ? 'none' : 'known'
        }
      }
      await $.state.set(HOST, { archiveTool, lead, leadState })
    } catch {
      // the previous answer stands
    } finally {
      hostLooking = null
    }
  })()
  return hostLooking
}

/**
 * The app's session record, read for its parent: `{ lead }` with the parent session id, or
 * null for none (no parent, or detached); null when the text is not such a record.
 */
function parentOf(text: string): { lead: string | null } | null {
  try {
    const data = JSON.parse(text) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    const record = data as Record<string, unknown>
    if (typeof record['sessionId'] !== 'string') return null
    const parent = record['parentSessionId']
    if (typeof parent !== 'string' || parent === '' || record['detached'] === true) return { lead: null }
    return { lead: parent.slice(0, 128) }
  } catch {
    return null
  }
}

/** Subagent statuses that count as running. */
const ACTIVE_AGENT = new Set(['pending', 'running', 'waiting'])

/**
 * Background work as the band can see it after a main-loop turn on a host that
 * raises no classic.Stop (the desktop, verified 2026-10-12): the running
 * subagents from $.agent.list(). Background shell tasks and scheduled wakeups
 * are listed by no engine noun, so they stay the app's to guard (its archive
 * refuses a session with live background work). A classic.Stop that does arrive
 * overwrites this with its fuller count. Never throws; a failed list leaves
 * the count unknown.
 */
async function observeBackground($: Engine): Promise<void> {
  try {
    const agents = await $.agent.list()
    const tasks = agents.filter(a => ACTIVE_AGENT.has(String(a.status))).length
    const at = await $.clock.now()
    stopSeq += 1
    await $.state.set(BACKGROUND, { tasks, crons: 0, at, seq: stopSeq, token: loadToken, source: 'agents' })
    if (isArmed) void refresh($, true)
  } catch {
    // unknown stays unknown
  }
}

/** Reads every value that bears on "done" and judges it now; isWorking is the caller's. */
async function judgeNow($: Engine, isWorking: boolean) {
  const [standingNow, queued, waitingNow, cardsNow, backgroundNow, hostNow, reportAt, now] = await Promise.all([
    read($, standing),
    read($, pending),
    read($, waiting),
    read($, cards),
    read($, background),
    read($, host),
    read($, lastReportAt),
    $.clock.now(),
  ])
  return completion({
    standing: standingNow,
    now,
    isWorking,
    hasPending: queued !== null && now - queued.at < PENDING_EXPIRY_MS,
    waiting: waitingNow.length,
    openDecisions: cardsNow === null ? 0 : cardsNow.questions.filter(q => q.picked === null).length,
    background: backgroundNow,
    lead: { state: hostNow.leadState, id: hostNow.lead },
    lastReportAt: reportAt,
  })
}

/** The person pressed Archive session: confirm, then ask the app to archive this one. Never throws. */
async function archiveSession($: Engine, reason: string): Promise<void> {
  try {
    const choice = await $.ui.ask(`Archive this session (${reason})? Finished side sessions sharing its worktree are archived with it.`, { options: ['Archive', 'Not yet'], header: 'Cockpit' })
    if (choice !== 'Archive') return
    // Judged again after the dialog, on fresh git readings: a wakeup, a task or an edit that
    // arrived meanwhile stops the archive. A re-read that did not land is no reading at all.
    const pressedAt = await $.clock.now()
    await refresh($, true)
    const fresh = await read($, standing)
    if (fresh === null || fresh.refreshedAt < pressedAt) {
      $.ui.toast('Cockpit: not archived, the standing could not be re-read.')
      return
    }
    const again = await judgeNow($, false)
    if (!again.isReady) {
      $.ui.toast(`Cockpit: not archived, something came up: ${again.blockers.join(', ')}.`)
      return
    }
    const res = await $.mcp.call(HOST_SERVER, ARCHIVE_TOOL, { session_id: 'self', reason: `cockpit: ${reason}` })
    if (res.isError) $.ui.toast('Cockpit: the app did not archive this session (tool error).')
  } catch (err) {
    $.ui.toast(`Cockpit: archive not done (${err instanceof Error && err.name ? err.name : 'error'}).`)
  }
}

async function lookPr($: Engine, cwd: string): Promise<{ pr: CockpitPr | null; prStatus: CockpitStanding['prStatus'] }> {
  const binaries = ghBinary !== null ? [ghBinary] : GH_CANDIDATES

  for (const binary of binaries) {
    const startedAt = await $.clock.now()
    const ran = await $.process
      .run([binary, 'pr', 'view', '--json', PR_FIELDS], { cwd, timeoutMs: PROCESS_TIMEOUT_MS })
      .catch(() => null)

    if (ran === null) {
      // A run that hung until the timeout did start: the CLI exists but is stuck (network, an auth
      // prompt). Trying the other paths would only wait as long again each, so the PR is unknown this round.
      if ((await $.clock.now()) - startedAt >= TIMEOUT_GUESS_MS) {
        ghBinary = binary

        return { pr: null, prStatus: 'error' }
      }

      continue
    }

    ghBinary = binary

    if (ran.exitCode === 0) {
      const pr = parsePr(ran.stdout)

      return pr === null ? { pr: null, prStatus: 'error' } : { pr, prStatus: 'ok' }
    }

    // gh exits 1 with these lines when the branch has no PR, or the repo no remote: facts, not failures.
    return /no pull requests found|no git remotes found/i.test(ran.stderr) ? { pr: null, prStatus: 'none' } : { pr: null, prStatus: 'error' }
  }

  ghBinary = null

  return { pr: null, prStatus: 'unavailable' }
}

async function stampActivity($: Engine): Promise<void> {
  try {
    const now = await $.clock.now()
    const held = await $.state.get(LAST_TOOL_AT)

    if (now - (held.value ?? 0) >= ACTIVITY_STAMP_MS) {
      await $.state.set(LAST_TOOL_AT, now, { ifVersion: held.version })
    }
  } catch {
    // Idle is advisory; a missed stamp only makes it read a little high.
  }
}

async function clearPendingFor($: Engine, text: string): Promise<void> {
  const held = await $.state.get(PENDING)

  if (held.value !== null && held.value !== undefined && normalizePrompt(held.value.text) === normalizePrompt(text)) {
    await $.state.set(PENDING, null, { ifVersion: held.version })
  }
}

/** Takes the last main-loop answer apart into decision cards and waiting items. */
async function absorbAnswer($: Engine, answer: string, turnId: string): Promise<void> {
  const questions = answer.trim() === '' ? [] : parseDecisions(answer)
  const held = await $.state.get(CARDS)

  if (questions.length > 0) {
    await $.state.set(CARDS, { turnId, questions })
  } else if (held.value !== null && held.value !== undefined) {
    await $.state.set(CARDS, null, { ifVersion: held.version })
  }

  // An answer without the marker leaves the list alone: items asked for earlier stay until the person types.
  const items = parseWaiting(answer)

  if (items.length > 0) {
    await $.state.set(WAITING, items)
  }
}

/** The two files a rule can go to; global is null when HOME is unset. */
async function rulePaths($: Engine): Promise<{ global: string | null; project: string }> {
  // $.fs does not expand "~": the home directory comes from the environment.
  const home = await $.env.get('HOME')

  return {
    global: home === undefined || home === '' ? null : `${home.replace(/\/+$/, '')}/.claude/captured-rules.md`,
    project: `${(await $.session.root()).replace(/\/+$/, '')}/CLAUDE.md`,
  }
}

/** The store's dedupe key for a rule in one file, so saving to one project never hides it from another. */
const ruleDigest = (path: string, sentence: string) => sha256Hex(`${path}\n${normalizeRule(sentence)}`)

/** Whether the rule already holds where this session reads rules: the global file or this project's CLAUDE.md. */
async function isRuleInForce($: Engine, sentence: string): Promise<boolean> {
  const paths = await rulePaths($)

  for (const path of [paths.global, paths.project]) {
    if (path === null) {
      continue
    }

    if ((await $.store.get(capturedKey(await ruleDigest(path, sentence))).catch(() => undefined)) === true) {
      return true
    }

    const text = await $.fs.read(path).catch(() => null)

    if (text !== null && hasRule(String(text), sentence)) {
      return true
    }
  }

  return false
}

/**
 * What a prompt that went through retires or raises in the band: a person's
 * prompt (PERSON_KINDS) retires the cards and the waiting list and may raise
 * a rule capture. Run only after the chain beneath let the prompt through.
 */
async function observePrompt($: Engine, text: string, kind: string, now: number): Promise<void> {
  if (!PERSON_KINDS.has(kind)) {
    return
  }

  // Cards answer the question they came with; the person's next prompt retires them (this plugin's own never reach here).
  const heldCards = await $.state.get(CARDS)

  if (heldCards.value !== null && heldCards.value !== undefined) {
    await $.state.set(CARDS, null, { ifVersion: heldCards.version })
  }

  const heldWaiting = await $.state.get(WAITING)

  if ((heldWaiting.value ?? []).length > 0) {
    await $.state.set(WAITING, [], { ifVersion: heldWaiting.version })
  }

  const sentence = findRuleSentence(text)

  if (sentence === null || (await isRuleInForce($, sentence))) {
    return
  }

  await $.state.set(RULE, { sentence, detectedAt: now })
}

/** Puts a dropped duplicate back as a draft, unless the person has already started typing something else. */
function scheduleRefill($: Engine, text: string): void {
  $.clock.after(REFILL_DELAY_MS, () => {
    void (async () => {
      try {
        const box = await $.prompt.read()

        if (box.text.trim() === '') {
          await $.prompt.fill({ text, mode: 'replace' })
        }
      } catch {
        // The drop reason already told the person; the draft is a courtesy.
      }
    })()
  })
}

// Band actions ----------------------------------------------------------------

async function sendReply($: Engine, label: string, text: string, isWorking: boolean): Promise<void> {
  const now = await $.clock.now()
  const held = await $.state.get(PENDING)
  const live = held.value !== null && held.value !== undefined && now - held.value.at < PENDING_EXPIRY_MS ? held.value : null

  // One quick reply in flight at a time, whichever it is: letters typed while the band holds the
  // focus (after a click on it) press these buttons, and "make sure…" must not send m, s, r and t.
  if (live !== null) {
    $.ui.toast('already queued')

    return
  }

  if (isWorking) {
    $.ui.toast(`Claude is working, so ${label} was not sent. Press it again once the turn ends.`)

    return
  }

  // Claim the send first, so a double press or a press from a second surface cannot submit twice.
  const claim = await $.state.set(PENDING, { text, at: now }, { ifVersion: held.version })

  if (!claim.isSet) {
    $.ui.toast('already queued')

    return
  }

  const result = await $.prompt.submit({ text, asUser: true }).catch(() => ({ drop: 'failed' }) as const)
  const after = await $.state.get(PENDING)

  if (after.value?.text === text && after.value.at === now) {
    await $.state.set(PENDING, null, { ifVersion: after.version })
  }

  if (result.drop !== undefined) {
    $.ui.toast(`${label} was not sent: a hook dropped it.`)
  }
}

async function restoreCards($: Engine, held: CockpitCards): Promise<void> {
  const now = await $.state.get(CARDS)

  if (now.value === null || now.value === undefined) {
    await $.state.set(CARDS, held, { ifVersion: now.version })
  }
}

const WORKING_TOAST = 'Claude is working. Press it again once the turn ends.'

async function sendAnswers($: Engine, mode: 'picked' | 'recommended', isWorking: boolean): Promise<void> {
  // Mid-turn, a fill would land in the box while Claude works and a no-box submit would queue behind it.
  if (isWorking) {
    $.ui.toast(WORKING_TOAST)

    return
  }

  const held = await $.state.get(CARDS)
  const current = held.value

  if (current === null || current === undefined) {
    return
  }

  const answers = current.questions.map(question => ({
    number: question.number,
    value: mode === 'recommended' ? question.recommended : (question.picked ?? question.recommended),
  }))
  const missing = answers.filter(answer => answer.value === null).map(answer => `Q${answer.number}`)

  if (missing.length > 0) {
    $.ui.toast(`Pick an answer for ${missing.join(', ')} first.`)

    return
  }

  // Clear the cards before anything is sent: a second press finds nothing to send.
  const claim = await $.state.set(CARDS, null, { ifVersion: held.version })

  if (!claim.isSet) {
    return
  }

  const text = answersText(answers.map(answer => ({ number: answer.number, value: answer.value ?? '' })))
  const filled = await $.prompt.fill({ text, mode: 'replace' }).catch(() => ({ isFilled: false, refusal: undefined }))
  const outcome = fillOutcome(filled)

  if (outcome === 'filled') {
    return
  }

  if (outcome === 'submit') {
    const result = await $.prompt.submit({ text, asUser: true }).catch(() => ({ drop: 'failed' }) as const)

    if (result.drop !== undefined) {
      await restoreCards($, current)
      $.ui.toast('Your answers were not sent: a hook dropped them. The cards are back.')
    }

    return
  }

  await restoreCards($, current)
  $.ui.toast(
    filled.refusal === 'dialog'
      ? 'A dialog holds the keys, so the answers were not put in the prompt. The cards are back.'
      : 'The prompt did not take the answers. The cards are back.',
  )
}

async function pickAnswer($: Engine, turnId: string, number: number, value: string): Promise<void> {
  await update($, cards, held =>
    held !== null && held.turnId === turnId
      ? {
          ...held,
          questions: held.questions.map(question =>
            question.number === number && question.options.some(option => option.value === value) ? { ...question, picked: value } : question,
          ),
        }
      : held,
  )
}

async function dismissCards($: Engine): Promise<void> {
  const held = await $.state.get(CARDS)

  if (held.value !== null && held.value !== undefined) {
    await $.state.set(CARDS, null, { ifVersion: held.version })
  }
}

async function markDone($: Engine, item: CockpitWaiting, isWorking: boolean): Promise<void> {
  if (isWorking) {
    $.ui.toast(WORKING_TOAST)

    return
  }

  let isRemoved = false

  await update($, waiting, list => {
    isRemoved = list.some(held => held.id === item.id && held.text === item.text)

    return isRemoved ? list.filter(held => held.id !== item.id) : list
  })

  if (!isRemoved) {
    return
  }

  // Cleaned again here: an item held from before a reload may predate the parser's cleaning.
  const result = await $.prompt.submit({ text: `Done: ${personText(item.text)}`, asUser: true }).catch(() => ({ drop: 'failed' }) as const)

  if (result.drop !== undefined) {
    await update($, waiting, list => (list.some(held => held.id === item.id) ? list : [...list, item]))
    $.ui.toast('"Done" was not sent: a hook dropped it. The item is back.')
  }
}

async function statOrNull($: Engine, path: string) {
  return $.fs.stat(path).catch(() => null)
}

/**
 * Read, insert under "## Captured rules", write: guarded by comparing the
 * file's mtime and size just before the write with what was read, and tried
 * once more on a change, since several sessions may capture at once and
 * $.fs has neither append nor a lock.
 */
async function writeRule($: Engine, path: string, sentence: string, preamble: string): Promise<'saved' | 'present' | 'conflict'> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await statOrNull($, path)

    if (before !== null && before.kind !== 'file') {
      throw new Error('not a file')
    }

    const text = before === null ? '' : String(await $.fs.read(path))

    if (hasRule(text, sentence)) {
      return 'present'
    }

    const updated = insertCapturedRule(text, sentence, preamble)
    const check = await statOrNull($, path)

    if ((before?.mtimeMs ?? -1) !== (check?.mtimeMs ?? -1) || (before?.size ?? -1) !== (check?.size ?? -1)) {
      continue
    }

    await $.fs.write(path, updated)

    return 'saved'
  }

  return 'conflict'
}

async function rememberRule($: Engine, path: string, sentence: string): Promise<void> {
  try {
    await $.store.set(capturedKey(await ruleDigest(path, sentence)), true)
  } catch {
    // The file itself is the dedupe of record; the store only saves a repeat prompt.
  }
}

async function restoreRule($: Engine, held: CockpitRule): Promise<void> {
  const now = await $.state.get(RULE)

  if (now.value === null || now.value === undefined) {
    await $.state.set(RULE, held, { ifVersion: now.version })
  }
}

async function saveRule($: Engine, target: 'global' | 'project'): Promise<void> {
  const held = await $.state.get(RULE)
  const candidate = held.value

  if (candidate === null || candidate === undefined) {
    return
  }

  const claim = await $.state.set(RULE, null, { ifVersion: held.version })

  if (!claim.isSet) {
    return
  }

  try {
    const paths = await rulePaths($)
    const path = target === 'global' ? paths.global : paths.project

    if (path === null) {
      await restoreRule($, candidate)
      $.ui.toast('HOME is not set, so there is nowhere to save global rules.')

      return
    }

    const outcome = await writeRule($, path, candidate.sentence, target === 'global' ? GLOBAL_PREAMBLE : '')

    if (outcome === 'conflict') {
      await restoreRule($, candidate)
      $.ui.toast(`${path} kept changing while saving. Nothing was written; press again.`)

      return
    }

    await rememberRule($, path, candidate.sentence)

    const done = outcome === 'present' ? `Already in ${path}.` : `Saved to ${path}.`
    // The global file loads only through an import line the person adds; the mod never edits ~/.claude/CLAUDE.md itself.
    const userClaude = path.replace(/captured-rules\.md$/, 'CLAUDE.md')
    const isLoaded = target === 'project' || (await isGlobalImported($, userClaude))

    $.ui.toast(isLoaded ? done : `${done} It is not loaded yet: add the line @captured-rules.md to ${userClaude}.`)
  } catch {
    await restoreRule($, candidate)
    $.ui.toast(`Could not save to ${target} rules. Nothing was written.`)
  }
}

/** Whether ~/.claude/CLAUDE.md imports the captured-rules file (outside code); unreadable reads as no. */
async function isGlobalImported($: Engine, userClaude: string): Promise<boolean> {
  const text = await $.fs.read(userClaude).catch(() => null)

  return text !== null && GLOBAL_IMPORT.test(stripFences(String(text)))
}

async function dismissRule($: Engine): Promise<void> {
  const held = await $.state.get(RULE)

  if (held.value !== null && held.value !== undefined) {
    await $.state.set(RULE, null, { ifVersion: held.version })
  }
}

// Hooks -------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const replies = REPLIES.map(reply => ({ ...reply, text: replyText(options, reply) }))

  // No band surface at start (-p, or the SDK before the desktop attaches): the
  // next events and session.attach ask again, so nothing polls until one draws.
  on('session.start', ($, e, next) => {
    void arm($, isBandSurface(e.surface)).catch(() => undefined)

    return next(e)
  })

  on('session.attach', ($, e, next) => {
    if (isBandSurface(e.surface)) {
      void arm($, true).catch(() => undefined)
    }

    return next(e)
  })

  // Observer: records when a tool last ran. Fails open, never refusing a tool.
  on('tool.call', async ($, e, next) => {
    void arm($).catch(() => undefined)
    void stampActivity($)
    if (!REPORT_TOOLS.has(e.tool) || e.agentId !== undefined) {
      return next(e)
    }
    // A report to the lead: the main loop's own message, delivered (no error), and for the app's
    // send_message addressed to the lead's id. SendMessage names a session by name, which the band
    // cannot match to the lead's id, so any delivered SendMessage from the main loop counts.
    const result = await next(e)
    try {
      // Delivered means the tool ran: the engine stamps `ref` on a result it produced, never on one a hook answered in its place.
      if (result.deny === undefined && result.isError !== true && typeof result.ref === 'number') {
        const hostNow = await read($, host)
        // The arguments ride flat on the event (`e.session_id`); an `input` object is read too, should a host nest them.
        const flat = e as unknown as Record<string, unknown>
        const nested = flat['input'] && typeof flat['input'] === 'object' ? (flat['input'] as Record<string, unknown>) : null
        const target = nested?.['session_id'] ?? flat['session_id']
        const isToLead = e.tool === 'SendMessage' || (hostNow.lead !== null && target === hostNow.lead)
        if (isToLead) await $.state.set(LAST_REPORT_AT, await $.clock.now())
      }
    } catch {
      // the stamp is best effort
    }
    return result
  }).catch(($, e, next) => next(e))

  // What the last main-loop Stop listed: background tasks and wakeups an archive would drop.
  // Absent arrays say nothing, so the count goes back to unknown rather than reading as none.
  on('classic.Stop', async ($, e, next) => {
    try {
      if (e.agent_id === undefined) {
        const tasks = Array.isArray(e.background_tasks) ? e.background_tasks.length : null
        const crons = Array.isArray(e.session_crons) ? e.session_crons.length : null
        const at = await $.clock.now()
        stopSeq += 1
        await $.state.set(BACKGROUND, tasks === null || crons === null ? null : { tasks, crons, at, seq: stopSeq, token: loadToken, source: 'stop' })
        // The standing must be read after this Stop before the session can read as done.
        if (isArmed) void refresh($, true)
      }
    } catch {
      // the previous count stands
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    void clearPendingFor($, e.text).catch(() => undefined)
    // A new turn may start background work: only a Stop after it says what is running.
    void $.state.set(BACKGROUND, null).catch(() => undefined)

    return next(e)
  })

  // Subagent turns fire this too: only the main loop's answer feeds the band.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined) {
      void arm($).catch(() => undefined)

      // What is running now (an un-armed session skips the refresh, not the count), then the standing.
      void observeBackground($)

      if (e.reason === 'answer') {
        await absorbAnswer($, e.answer, e.turnId).catch(() => undefined)
      }
    }

    return result
  })

  // The duplicate guard fails open: a throw lets the prompt through (the .catch replays next).
  on('prompt.submit', async ($, e, next) => {
    void arm($).catch(() => undefined)

    const kind = e.origin.kind
    const isPerson = PERSON_KINDS.has(kind)
    const normalized = isPerson ? normalizePrompt(e.text) : ''
    const digest = normalized === '' ? null : await sha256Hex(normalized)
    const now = await $.clock.now()

    if (digest !== null && e.turnId !== undefined && e.wait !== true) {
      const held = await $.state.get(RECENT)
      const twin = (held.value ?? []).find(entry => entry.hash === digest && now - entry.at <= DUPLICATE_WINDOW_MS)

      if (twin !== undefined) {
        scheduleRefill($, e.text)

        return {
          drop: `cockpit: dropped a duplicate. You sent ${promptPreview(e.text)} ${Math.max(1, Math.round((now - twin.at) / 1000))}s ago and a turn is still running; the text goes back in the prompt, and ctrl+x enter queues it anyway.`,
        }
      }
    }

    if (digest !== null) {
      await update($, recent, list => [...list.filter(entry => entry.hash !== digest), { hash: digest, at: now }].slice(-RECENT_LIMIT))
    }

    const result = await next(e)

    if (result.drop !== undefined) {
      // A prompt something beneath dropped was never sent: it cannot be duplicated, and it answers nothing.
      if (digest !== null) {
        await update($, recent, list => list.filter(entry => !(entry.hash === digest && entry.at === now))).catch(() => undefined)
      }

      return result
    }

    await observePrompt($, e.text, kind, now).catch(() => undefined)

    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The band is shared with surveys, and a subagent's transcript is not the session's cockpit.
    if (e.props.hasSurvey || e.props.view.agentId !== undefined || (e.surface !== 'terminal' && e.surface !== 'desktop')) {
      return next(e)
    }

    const { Box, Button, Select, Text } = $.ui.resolve(e)
    const fold = await read($, collapsed)
    const queued = await read($, pending)
    const standingNow = await read($, standing)
    const toolAt = await read($, lastToolAt)
    const cardsNow = await read($, cards)
    const waitingNow = await read($, waiting)
    const ruleNow = await read($, rule)
    const reportAt = await read($, lastReportAt)
    const backgroundNow = await read($, background)
    const hostNow = await read($, host)
    const now = await $.clock.now()
    const isWorking = e.props.isWorking
    const done = completion({
      standing: standingNow,
      now,
      isWorking,
      hasPending: queued !== null && now - queued.at < PENDING_EXPIRY_MS,
      waiting: waitingNow.length,
      openDecisions: cardsNow === null ? 0 : cardsNow.questions.filter(q => q.picked === null).length,
      background: backgroundNow,
      lead: { state: hostNow.leadState, id: hostNow.lead },
      lastReportAt: reportAt,
    })
    const reason = archiveReason(standingNow)
    // An idle session that is not done says what stands, so the missing button is never a mystery.
    const showBlockers = !done.isReady && !isWorking && standingNow !== null
    const width = Math.max(1, e.props.bodyColumns)
    const queuedLabel = queued !== null && now - queued.at < PENDING_EXPIRY_MS ? (replies.find(reply => reply.text === queued.text)?.label ?? 'reply') : null

    const toggle = (section: keyof CockpitCollapsed, title: string) => (
      <Button
        key={`fold-${section}`}
        plain
        dimColor
        label={`${fold[section] ? '▸' : '▾'} ${title}`}
        onPress={() => {
          void update($, collapsed, held => ({ ...held, [section]: !held[section] }))
        }}
      />
    )

    const allRecommended = cardsNow !== null && cardsNow.questions.every(question => question.recommended !== null)
    // A phrase set in the options can say anything, as the person: show it wherever it differs from the default.
    const custom = replies.filter(reply => reply.text !== reply.fallback)
    // What Send answers puts in the prompt (or sends as the person where there is no prompt box), shown before the press.
    const answersPreview =
      cardsNow === null
        ? ''
        : answersText(cardsNow.questions.map(question => ({ number: question.number, value: question.picked ?? question.recommended ?? '?' })))
    const recommendedPreview =
      cardsNow === null ? '' : answersText(cardsNow.questions.map(question => ({ number: question.number, value: question.recommended ?? '?' })))

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {toggle('replies', 'Replies')}
          {!fold.replies &&
            replies.map(reply => (
              <Button
                key={`reply-${reply.id}`}
                {...(reply.hotkey === undefined ? {} : { hotkey: reply.hotkey })}
                label={reply.label}
                dimColor={isWorking}
                onPress={() => {
                  void sendReply($, reply.label, reply.text, isWorking)
                }}
              />
            ))}
          {!fold.replies && queuedLabel !== null && <Text dimColor>queued: {queuedLabel}</Text>}
        </Box>
        {!fold.replies &&
          custom.map(reply => (
            <Text key={`custom-${reply.id}`} dimColor wrap="wrap">
              {reply.label} sends: "{reply.text}"
            </Text>
          ))}
        <Box flexDirection="row" columnGap={1}>
          {toggle('standing', 'Standing')}
          {!fold.standing && (
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                {standingLine(standingNow, now, toolAt, isWorking)}
              </Text>
            </Box>
          )}
          {!fold.standing && done.isReady && hostNow.archiveTool && (
            <Button key="archive" label="Archive session" onPress={() => void archiveSession($, reason)} />
          )}
          {!fold.standing && done.isReady && !hostNow.archiveTool && <Text dimColor>done: ready to archive (use the app)</Text>}
        </Box>
        {!fold.standing && showBlockers && (
          <Text dimColor wrap="truncate-end">
            archive after: {done.blockers.join(', ')}
          </Text>
        )}
        {cardsNow !== null && (
          <Box flexDirection="column">
            {toggle('cards', `Decisions (${cardsNow.questions.length})`)}
            {!fold.cards &&
              cardsNow.questions.map(question => (
                <Box flexDirection="column">
                  <Text wrap="truncate-end">
                    Q{question.number} {question.text}
                  </Text>
                  <Select
                    key={`pick-${question.number}`}
                    options={question.options.map(option => ({
                      value: option.value,
                      label: `${option.value}) ${option.label}${option.value === question.recommended && !labelMarksRecommended(option.label) ? ' (recommended)' : ''}`,
                    }))}
                    value={question.picked ?? question.recommended ?? undefined}
                    onSelect={value => {
                      void pickAnswer($, cardsNow.turnId, question.number, value)
                    }}
                  />
                </Box>
              ))}
            {!fold.cards && (
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                <Button
                  key="cards-send"
                  variant="primary"
                  label="Send answers"
                  dimColor={isWorking}
                  onPress={() => {
                    void sendAnswers($, 'picked', isWorking)
                  }}
                />
                {allRecommended && (
                  <Button
                    key="cards-accept"
                    label="Accept all recommended"
                    dimColor={isWorking}
                    onPress={() => {
                      void sendAnswers($, 'recommended', isWorking)
                    }}
                  />
                )}
                <Button
                  key="cards-dismiss"
                  role="dismiss"
                  label="Dismiss"
                  onPress={() => {
                    void dismissCards($)
                  }}
                />
              </Box>
            )}
            {!fold.cards && (
              <Text key="cards-preview" dimColor wrap="wrap">
                Send answers sends: "{answersPreview}"
                {allRecommended && recommendedPreview !== answersPreview ? `; Accept all sends: "${recommendedPreview}"` : ''}
              </Text>
            )}
          </Box>
        )}
        {waitingNow.length > 0 && (
          <Box flexDirection="column">
            {toggle('waiting', `Waiting on you (${waitingNow.length})`)}
            {!fold.waiting &&
              waitingNow.map(item => (
                <Box flexDirection="row" columnGap={1}>
                  <Button
                    key={`done-${item.id}`}
                    label="Done"
                    dimColor={isWorking}
                    onPress={() => {
                      void markDone($, item, isWorking)
                    }}
                  />
                  {/* Wrapped, never cut: Done sends this text as the person's words, so all of it must be in view. */}
                  <Box flexShrink={1}>
                    <Text wrap="wrap">{personText(item.text)}</Text>
                  </Box>
                </Box>
              ))}
          </Box>
        )}
        {ruleNow !== null && (
          <Box flexDirection="column">
            {toggle('rule', 'Save as a standing rule?')}
            {!fold.rule && <Text>"{ruleNow.sentence}"</Text>}
            {!fold.rule && (
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                <Button
                  key="rule-global"
                  label="Global rules"
                  onPress={() => {
                    void saveRule($, 'global')
                  }}
                />
                <Button
                  key="rule-project"
                  label="Project rules"
                  onPress={() => {
                    void saveRule($, 'project')
                  }}
                />
                <Button
                  key="rule-dismiss"
                  label="Dismiss"
                  onPress={() => {
                    void dismissRule($)
                  }}
                />
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
