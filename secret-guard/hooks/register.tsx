/**
 * secret-guard: holds a prompt that carries a credential shape before it
 * reaches the model, and offers to send it redacted, with a note telling the
 * model where the value really lives.
 *
 * Two `prompt.submit` registrations, both failing closed:
 *
 * - The person's own prompts (composer, Remote Control bridge, SDK host) get
 *   a dialog: Redact and reference / Send anyway / Cancel. A dialog nobody
 *   answers (dismissed, headless, refused) falls back to redaction so the flow
 *   continues safely; an explicit Cancel holds the prompt and puts the draft
 *   back, redacted.
 * - Every other origin (peers, task notifications, schedules, channels,
 *   plugins, and any origin a later build adds) is redacted with no dialog: a
 *   dialog nobody started would stall the session.
 *
 * Each registration decides before it calls `next`, and its `.catch` drops the
 * prompt when the hook fails before deciding, so a bug, a timeout or a
 * re-entry never lets the value through. No matched value ever reaches a
 * toast, the dialog, a log line, an error or `$.store`: only kinds and
 * placeholders do. The mod keeps no state.
 */
import type { EngineInterface, PluginOptions, PromptFilled, PromptSubmitInput, Register } from 'claude-code'

import { CANDIDATE_RE, KINDS, hasCredential, kindsPhrase, redact } from './scan'
import type { KindId, Redaction } from './scan'

const REDACT = 'Redact and reference'
const SEND = 'Send anyway'
const CANCEL = 'Cancel'
const CHOICES = [REDACT, SEND, CANCEL] as const

/** What the `.catch` answers when a hook fails before deciding: the prompt is held. */
const HOLD = 'secret-guard: prompt held, possible credential detected'

/**
 * The person's own origins, and their exact complement. Regexes rather than a
 * list: the complement then covers an origin kind a later build adds, and the
 * declarations type a list of kinds per origin variant, which refuses a
 * several-kind list there (the engine itself takes either form).
 */
const ATTENDED = /^(?:composer|bridge|sdk)$/
const UNATTENDED = /^(?!(?:composer|bridge|sdk)$)/

const REFILL_DELAY_MS = 150
const REFILL_RETRIES = 3
const MAX_HINT_LENGTH = 200

type Settings = {
  readonly enabled: ReadonlySet<KindId>
  readonly hints: ReadonlyMap<KindId, string>
}

const ALL_KINDS: ReadonlySet<KindId> = new Set(KINDS.map(kind => kind.id))

/**
 * Reads the userConfig fields. Anything but an explicit `false` keeps a kind
 * on, so a missing or mistyped option never switches the guard off; a hint
 * that is empty, multi-line, too long or itself credential-shaped falls back
 * to the default, so a setting can't smuggle a value into the model's context.
 */
function readSettings(options: PluginOptions): Settings {
  const enabled = new Set<KindId>()
  const hints = new Map<KindId, string>()
  for (const kind of KINDS) {
    if (options[`scan${kind.option}`] !== false) enabled.add(kind.id)
    const hint = options[`hint${kind.option}`]
    const isUsable =
      typeof hint === 'string' &&
      hint.trim() !== '' &&
      hint.length <= MAX_HINT_LENGTH &&
      !/[\r\n]/.test(hint) &&
      !hasCredential(hint, ALL_KINDS)
    hints.set(kind.id, isUsable ? hint.trim() : kind.hint)
  }
  return { enabled, hints }
}

const labelOf = (id: KindId) => KINDS.find(kind => kind.id === id)?.label ?? id

/** Who sent a message the person did not type, in words for the note and the toast. */
function sourceOf(origin: PromptSubmitInput['origin']): string {
  switch (origin.kind) {
    case 'peer':
    case 'peer-send-message':
      return 'a message from another Claude session'
    case 'task-notification':
      return 'a background task notification'
    case 'scheduled-trigger':
      return 'a scheduled prompt'
    case 'channel':
      return 'a channel message'
    case 'coordinator':
    case 'projects-relay':
      return 'a coordinating session message'
    case 'observer':
    case 'observer-activity':
      return 'an observer report'
    case 'auto-continuation':
      return 'an automatic follow-up'
    case 'plugin':
      return 'a plugin-submitted prompt'
    default:
      return `a ${origin.kind} message`
  }
}

/** The context entry only the model reads: what was removed, and where each value really lives. */
function referenceNote(found: Redaction, settings: Settings, source: string): string {
  const count = found.findings.length
  return [
    `secret-guard: ${source} held ${count} credential-shaped value${count === 1 ? '' : 's'}, removed before it reached you and replaced with placeholders:`,
    ...found.findings.map(
      finding =>
        `- ${finding.placeholder}: a ${labelOf(finding.kind)} credential. Where it lives: ${settings.hints.get(finding.kind)}`,
    ),
    'Treat each placeholder as a reference, never as the value itself, and never write it into a file or command as if it were one. When a command needs a value, read it at run time from where it lives (an environment variable, `op read op://...`, `wrangler secret ...`) without printing it. Never ask the person to paste a credential into the chat again; if you do not know where one lives, ask for the name of the variable or secret store, not the value.',
  ].join('\n')
}

function withReference(e: PromptSubmitInput, found: Redaction, settings: Settings, source: string): PromptSubmitInput {
  return { ...e, text: found.redacted, context: [...(e.context ?? []), referenceNote(found, settings, source)] }
}

/** Toasts never decide anything, so one that fails must not fail the guard. */
function notify($: EngineInterface, text: string): void {
  try {
    $.ui.toast(text, { timeoutMs: 6000 })
  } catch {
    // The decision already stands; a missing toast costs only the notice.
  }
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)

/**
 * Puts the held draft, redacted, back in the prompt box once the drop has
 * landed (a timer, so the engine's own handling of the drop comes first).
 * A dialog still closing gets a few retries; a session with no prompt box (the
 * desktop app) gets the clipboard instead, and the person is told either way.
 */
function refillLater($: EngineInterface, text: string, attempt = 0): void {
  $.clock.after(REFILL_DELAY_MS, () => {
    void refill($, text, attempt)
  })
}

export type RefillStep = 'done' | 'retry' | 'clipboard' | 'give-up'

/**
 * What to do after a refill attempt. Only the engine sets a refusal's cause
 * (a hook's own refusal arrives with none), so an absent cause is treated as
 * unknown and gives up rather than guessing that no prompt box exists.
 */
export function nextRefillStep(filled: Pick<PromptFilled, 'isFilled' | 'refusal'>, attempt: number): RefillStep {
  if (filled.isFilled) return 'done'
  if (filled.refusal === 'dialog') return attempt < REFILL_RETRIES ? 'retry' : 'give-up'
  if (filled.refusal === 'no_composer') return 'clipboard'
  return 'give-up'
}

const NOT_PUT_BACK = 'secret-guard: the held draft could not be put back in the prompt box.'

async function refill($: EngineInterface, text: string, attempt: number): Promise<void> {
  try {
    const step = nextRefillStep(await $.prompt.fill({ text, mode: 'replace' }), attempt)
    if (step === 'done') return
    if (step === 'retry') return refillLater($, text, attempt + 1)
    if (step === 'clipboard') {
      const copied = await $.ui.copy({ text })
      notify($, copied.isCopied ? 'secret-guard: the held draft, value redacted, is on your clipboard.' : NOT_PUT_BACK)
      return
    }
    notify($, NOT_PUT_BACK)
  } catch {
    notify($, NOT_PUT_BACK)
  }
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('prompt.submit', { origin: { kind: ATTENDED }, text: CANDIDATE_RE }, async ($, e, next) => {
    const found = redact(e.text, settings.enabled)
    if (found.findings.length === 0) return next(e)
    const kinds = kindsPhrase(found.kinds)
    const count = found.findings.length

    let answer: string | undefined
    try {
      answer = await $.ui.ask(`secret-guard: a possible ${kinds} credential is in your prompt. How should it go?`, CHOICES)
    } catch {
      // Dismissed, headless (-p) or refused: nobody answered, so send it redacted.
      answer = undefined
    }

    if (answer === undefined || answer === REDACT) {
      notify(
        $,
        answer === undefined
          ? `secret-guard: no answer, so the possible ${kinds} ${plural(count, 'credential was', 'credentials were')} redacted before sending.`
          : `secret-guard: redacted ${count} possible ${kinds} ${plural(count, 'credential', 'credentials')}; Claude was told where to read ${plural(count, 'it', 'them')}.`,
      )
      return next(withReference(e, found, settings, "the person's prompt"))
    }

    if (answer === SEND) {
      notify(
        $,
        `secret-guard: sent as typed. The ${kinds} value is now in this session's transcript; rotate it if it must stay secret.`,
      )
      return next(e)
    }

    // Cancel, or words typed under "Other": hold it and give the draft back, redacted.
    refillLater($, found.redacted)
    return { drop: `Held: possible ${kinds} credential in prompt. The draft goes back in the prompt box with the value redacted.` }
  }).catch(($, e, next) => (next.called ? next(e) : { drop: HOLD }))

  on('prompt.submit', { origin: { kind: UNATTENDED }, text: CANDIDATE_RE }, ($, e, next) => {
    const found = redact(e.text, settings.enabled)
    if (found.findings.length === 0) return next(e)
    const source = sourceOf(e.origin)
    const count = found.findings.length
    notify(
      $,
      `secret-guard: redacted ${count} possible ${kindsPhrase(found.kinds)} ${plural(count, 'credential', 'credentials')} from ${source}.`,
    )
    return next(withReference(e, found, settings, source))
  }).catch(($, e, next) => (next.called ? next(e) : { drop: HOLD }))
}
