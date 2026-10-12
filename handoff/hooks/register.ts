// handoff: the /handoff command. A handoff note is written from this
// conversation (one tool-less model call over it), cleaned and redacted, saved
// under ~/.claude/handoffs/; then the conversation is cleared and the next
// prompt is pre-filled to continue from the note, never sent. mem-gauge's
// Hand off button and the cockpit band's Hand off chip run this command, so
// the flow lives in one place.
//
// The engine requires `$` to be handed only to functions declared at the top of
// this file, so every function that touches `$` lives here; the note's prompt,
// cleaning, redaction and path are pure and live in handoff.ts.

import type { EngineInterface, Register } from 'claude-code'

import { HANDOFF_PROMPT, handoffFile, handoffPath } from './handoff'

type Dollar = EngineInterface

/**
 * The origins that may start a hand-off: the person's own (their Enter, the
 * Remote Control bridge, the SDK host behind the desktop app) and a plugin
 * (mem-gauge's button, the cockpit chip; the person still confirms in the
 * dialog). Every other kind (a peer session, a task notification, a scheduled
 * trigger, a channel, an unknown or unstamped origin) is refused: nothing
 * outside the person's reach may clear this conversation.
 */
const ACCEPTED_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk', 'plugin'])
/** The origins whose `args` are the person's own words, and so may become the note's focus. */
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])
const HAND_OFF = 'Hand off'
/** The focus line's cap, in code points: a sentence or two, never a pasted document. */
const FOCUS_MAX = 300
const GIT_TIMEOUT_MS = 3000
/**
 * How long a claim the flow never picked up blocks another /handoff. The flow
 * runs from a zero-delay timer; when another plugin refuses that timer the
 * refusal arrives later and the flow never starts, so a claim older than this
 * that was never started is taken over instead of blocking until a reload.
 */
const CLAIM_STALE_MS = 10_000

const TEXT_REFUSED_ORIGIN = "handoff: runs only from the composer or a mod's button; nothing was done."
const TEXT_TURN_RUNNING = 'handoff: a turn is running; run /handoff once it has finished, so the note covers it.'
const TEXT_IN_FLIGHT = 'handoff: a hand-off is already in progress.'
const TEXT_NOT_STARTED = 'handoff: could not start; nothing was done.'
const TEXT_TURN_MEANWHILE = 'handoff: a turn started meanwhile; run /handoff once it has finished.'
const TEXT_SCHEDULED =
  'handoff: confirm in the dialog. The note is written to ~/.claude/handoffs/ before anything is cleared; if any step fails, nothing is cleared.'
const QUESTION =
  'A handoff note is written from this conversation, the conversation is cleared (the old one stays resumable by its id), and the next prompt is pre-filled to continue from the note. Hand off to a fresh session?'

// Per-load plumbing, not state: register() starts these over, so a hot reload
// never inherits a claim or a turn it did not see begin.
// True while a main-loop turn runs (turn.start to turn.complete): the note would
// miss the turn's work and /clear would cut it short.
let turnInFlight = false
// The hand-off in flight, under a token so only the run that claimed releases
// (a reload resets it; a timer from before it can no longer clear a new claim).
// `at` is when the hook took it; `isStarted` turns true once the flow picks it
// up, so a claim whose timer never ran goes stale (CLAIM_STALE_MS) and heals.
let claim: { token: number; at: number; isStarted: boolean } | null = null
let nextClaim = 0

// Small copies of mem-gauge's helpers (parse.ts, advice.ts, register.tsx). Mods
// are self-contained plugins with no shared module between them, the same
// reason rd-ledger and usage-gauge each carry the price table.

/** An error's kind only: a message could carry a path or command output. */
const kindOf = (err: unknown): string => (err instanceof Error && err.name ? err.name : 'error')

/** An engine session id as a file-name piece: letters, digits, `_` and `-`, at most 128. */
const isSessionId = (id: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(id)

/**
 * A HOME the note's path may be built under: absolute, no `.` or `..` segment
 * (so it cannot spell the disk root as `/.` or `/Users/..`), at least one
 * segment, no control characters. Null otherwise: the hand-off says so and
 * stops before the model call.
 */
function applyHome(home: string | null): string | null {
  if (!home || !home.startsWith('/') || /[\u0000-\u001f\u007f]/.test(home)) return null
  const segments = home.split('/').filter(part => part !== '')
  if (segments.length === 0 || segments.some(part => part === '.' || part === '..')) return null
  return `/${segments.join('/')}`
}

/**
 * Text as one printable line: control characters and line or paragraph
 * separators become spaces; format characters (bidi overrides, zero-width,
 * Unicode tags), lone surrogates and private-use code points are dropped; runs
 * of whitespace collapse; the result is cut to `max` code points. Keeps a repo
 * name or a typed focus from adding lines to the note's header or the prompt.
 */
const oneLine = (text: string, max: number): string =>
  [
    ...text
      .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/[\p{Cf}\p{Cs}\p{Co}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, max)
    .join('')
    .trim()

const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/** A git branch name safe to put in a header: printable ASCII, one line, at most 100. */
const cleanBranch = (text: string): string | null => {
  const line = text.trim().split('\n')[0] ?? ''
  return /^[\x21-\x7e]{1,100}$/.test(line) ? line : null
}

/** Why a fork gave no note, for a toast: its reason, an API error's status (or kind when no response came). */
const forkFailure = (r: { reason: string; status?: number | null; error?: string }): string =>
  r.reason === 'api-error' ? `api-error ${r.status ?? r.error ?? 'unknown'}` : r.reason

/**
 * What the person typed after `/handoff`, as the note's focus: one printable
 * line of at most 300 code points (the input is cut first, so a huge paste
 * costs nothing); empty when nothing usable was typed.
 */
const cleanFocus = (args: string): string => oneLine(args.slice(0, FOCUS_MAX * 4), FOCUS_MAX)

/** The fork's prompt: the fixed note request, plus the person's focus as a closing paragraph when there is one. */
const forkPrompt = (focus: string): string =>
  focus === '' ? HANDOFF_PROMPT : `${HANDOFF_PROMPT}\n\nFocus for the next session (from the person): ${focus}`

/**
 * "<repo basename> · <branch>" for the note's header and file name, from the
 * session's root and the branch checked out in its working folder (`git
 * rev-parse --abbrev-ref HEAD`, argv only, 3 s). Any failure (no git, not a
 * repository, a timeout, an odd branch name) leaves the basename alone.
 */
async function sessionLabel($: Dollar): Promise<string> {
  let name = 'session'
  try {
    name = oneLine(basename(await $.session.root()), 100) || 'session'
    const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: await $.session.cwd(), timeoutMs: GIT_TIMEOUT_MS })
    const branch = r.exitCode === 0 && !r.isStdoutTruncated ? cleanBranch(r.stdout) : null
    return branch ? `${name} · ${branch}` : name
  } catch {
    return name
  }
}

/**
 * Hand this session off to a fresh one, after the person confirms: one
 * tool-less model call over this session's own transcript ($.model.fork,
 * served from its prompt cache) writes a note, which is cleaned, redacted and
 * written under ~/.claude/handoffs/; then /clear runs and the composer is
 * pre-filled with a line pointing at the note. The person presses Enter: the
 * fresh session's first prompt is never sent on its own.
 *
 * The order is the safety: nothing is cleared until the note is on disk, so a
 * dismissed dialog, a refused fork, an empty reply or a failed write leaves the
 * conversation as it was, and a refused /clear leaves the note and says where
 * it is. The old conversation stays resumable by the id the header names. The
 * only process is `git rev-parse` for the label; the only file is the note.
 *
 * A turn may start while the dialog is open or the note is being written (the
 * person typed and sent): the turn is checked again after the dialog, so
 * nothing is written, and right before /clear, so the note stays and nothing
 * is cleared; either way a toast says to run it once the turn has finished.
 *
 * Runs from a zero-delay timer the /handoff hook set (the engine refuses queued
 * work such as /clear from inside command.run); `token` is the claim the hook
 * took, marked started first and released here whatever happens. A run whose
 * claim was taken over (it went stale before this timer ran) does nothing.
 */
async function runHandoff($: Dollar, focus: string, token: number): Promise<void> {
  if (claim?.token !== token) return
  claim.isStarted = true
  try {
    let choice: string
    try {
      // AskUserQuestion wants the question to end in a question mark, so what happens comes first.
      choice = await $.ui.ask(QUESTION, { options: [HAND_OFF, 'Cancel'], header: HAND_OFF })
    } catch {
      return // dismissed, or nobody to ask (-p)
    }
    if (choice !== HAND_OFF) return
    if (turnInFlight) {
      $.ui.toast(TEXT_TURN_MEANWHILE)
      return
    }

    const sessionId = await $.session.id()
    if (!isSessionId(sessionId)) {
      $.ui.toast('handoff: hand off failed (no session id); nothing was cleared.')
      return
    }
    // Checked before the model call, so a note that could never be written costs nothing.
    const home = applyHome((await $.env.get('HOME')) ?? null)
    if (!home) {
      $.ui.toast('handoff: could not write the handoff note (HOME unknown); nothing was cleared.')
      return
    }
    const label = await sessionLabel($)

    const r = await $.model.fork({ prompt: forkPrompt(focus) })
    if (!r.isAnswered) {
      $.ui.toast(r.reason === 'nothing-to-fork' ? 'handoff: nothing to hand off yet.' : `handoff: the handoff note could not be written (${forkFailure(r)}).`)
      return
    }
    const now = await $.clock.now()
    const text = handoffFile(r.text, label, sessionId, now)
    if (text === '') {
      $.ui.toast('handoff: the handoff note could not be written (empty-reply).')
      return
    }
    const path = handoffPath(home, label, sessionId, now)
    try {
      await $.fs.write(path, text)
    } catch (err) {
      $.ui.toast(`handoff: could not write the handoff note (${kindOf(err)}); nothing was cleared.`)
      return
    }

    // The fork and the write take seconds: a turn sent meanwhile would be cut short by /clear.
    if (turnInFlight) {
      $.ui.toast(`handoff: note written at ${path}; a turn is running, so nothing was cleared. Run /clear (or /handoff) once it has finished.`)
      return
    }
    try {
      await $.command.run({ command: 'clear' })
    } catch {
      $.ui.toast(`handoff: note written at ${path}; run /clear yourself when ready.`)
      return
    }
    try {
      // A durable line in the fresh conversation (not sent to the model): a toast vanishes.
      $.ui.log(`handoff: note at ${path}`)
    } catch {
      // The toast below still names the path.
    }

    let isFilled = false
    try {
      // A draft the person typed meanwhile is kept: the continue line goes under it.
      let hasDraft = false
      try {
        hasDraft = (await $.prompt.read()).text.trim() !== ''
      } catch {
        hasDraft = false
      }
      const line = `Continue from the handoff note at ${path}: read it first, then carry on with its next step.`
      const filled = await $.prompt.fill(hasDraft ? { text: `\n${line}`, mode: 'append' } : { text: line, mode: 'replace' })
      isFilled = filled.isFilled
    } catch {
      // The note and the clear stand; the toast says where the note is.
    }
    $.ui.toast(`handoff: note at ${path}; the conversation was cleared.${isFilled ? '' : ' Paste that path into the next prompt.'}`)
  } catch (err) {
    $.ui.toast(`handoff: hand off failed (${kindOf(err)}).`)
  } finally {
    if (claim?.token === token) claim = null
  }
}

/**
 * The /handoff hook's body: refuses an origin outside the person's reach, a
 * running turn or a live claim (one not stale: started, or under
 * CLAIM_STALE_MS old), then takes the claim and sets the zero-delay timer that
 * runs the flow. Nothing is awaited between the claim check and taking it, so
 * two dispatches cannot both pass.
 */
async function startHandoff($: Dollar, e: { args?: string; origin?: { kind: string } }): Promise<{ text: string }> {
  const kind = e.origin?.kind
  if (kind === undefined || !ACCEPTED_ORIGINS.has(kind)) return { text: TEXT_REFUSED_ORIGIN }
  // Before the clock read: a refused read must not turn "a turn is running" into "could not start".
  if (turnInFlight) return { text: TEXT_TURN_RUNNING }
  const now = await $.clock.now()
  if (turnInFlight) return { text: TEXT_TURN_RUNNING }
  if (claim !== null && (claim.isStarted || now - claim.at < CLAIM_STALE_MS)) return { text: TEXT_IN_FLIGHT }
  // A plugin's args are not the person's words, so only the person's own origins set the focus.
  const focus = PERSON_ORIGINS.has(kind) ? cleanFocus(e.args ?? '') : ''
  nextClaim += 1
  const token = nextClaim
  claim = { token, at: now, isStarted: false }
  try {
    $.clock.after(0, () => {
      void runHandoff($, focus, token)
    })
  } catch (err) {
    if (claim?.token === token) claim = null
    return { text: `handoff: could not start (${kindOf(err)}); nothing was done.` }
  }
  return { text: TEXT_SCHEDULED }
}

export const register: Register = on => {
  turnInFlight = false
  claim = null

  // Registered before next(e), so plugins beneath (mem-gauge, cockpit) see the
  // command in $.command.list() during their own session.start.
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'handoff',
        description: 'Hand this session off to a fresh one: a note is written to ~/.claude/handoffs/, the conversation is cleared, the next prompt is pre-filled',
        argumentHint: '[focus for the next session]',
      })
    } catch (err) {
      $.ui.log(`handoff: /handoff not registered (${kindOf(err)})`, { to: 'debug' })
    }
    return next(e)
  })

  // turn.start fires for the main loop only; its prompt text is never read.
  // A chain beneath that rejects may never see its turn.complete: the flag is undone then.
  on('turn.start', async (_$, e, next) => {
    turnInFlight = true
    try {
      return await next(e)
    } catch (err) {
      turnInFlight = false
      throw err
    }
  })

  // turn.complete fires for subagent turns too: only the main loop's ends the turn.
  // Cleared in a finally: a hook beneath that fails rejects next(e), and the
  // flag must not stay stuck (it would refuse every /handoff until a reload).
  on('turn.complete', async (_$, e, next) => {
    try {
      return await next(e)
    } finally {
      if (e.agentId === undefined) turnInFlight = false
    }
  })

  // Answers at once and runs the flow from a timer: the dialog, the fork and
  // the /clear are queued work the engine will not run inside command.run.
  on('command.run', { command: 'handoff' }, async ($, e) => {
    // Every path answers the command, a failure included (a refused clock read).
    return startHandoff($, e).catch(() => ({ text: TEXT_NOT_STARTED }))
  })
}
