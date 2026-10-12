import { atom, update, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModelPinSource } from '../types'
import { clip, isAlias, isComparable, isValidPin, normalizeModel, sameModel, silentSwitchArg } from './pin'

// Per-session facts live in $.state (a hot reload keeps them; a module
// variable would not), each named by a literal plugin/key reference.
const reappliedOnce = atom({ plugin: 'model-pin', key: 'reappliedOnce' } as const, false)
const drifted = atom({ plugin: 'model-pin', key: 'drifted' } as const, false)
const toastShown = atom({ plugin: 'model-pin', key: 'toastShown' } as const, false)
const retryAt = atom({ plugin: 'model-pin', key: 'retryAt' } as const, 0)

/*
 * Where a pin can come from, highest precedence first. The settings sources
 * follow the engine's own order (policy, then --settings, then local, project,
 * user: the merge takes `model` from the highest source that has it), so a
 * settings pin is the model the engine itself starts on, unless --model or
 * ANTHROPIC_MODEL overrides it at launch (neither is a source the mod can
 * read), and the mod never fights a managed setting or a person's own
 * settings.local.json. The /model-pin override is a personal pin for the whole
 * repository, so it sits above the committed project file but below this
 * checkout's local file. The engine never reads the override, so a session
 * starts on the settings model and an override that differs shows as drift at
 * every start. User settings only count when the person opts in: a global
 * default is not a decision about this project, and treating it as one would
 * push every cheaper session back onto it.
 */
const PIN_LAYERS = ['policy', 'flag', 'local', 'override', 'project'] as const
const pinLayers = (includeUser: boolean): readonly ModelPinSource[] =>
  includeUser ? [...PIN_LAYERS, 'user'] : PIN_LAYERS

// The engine's own fallback (overload, rate limit) gets this long to clear
// before the one automatic re-apply, so the pin does not fight it.
const AUTO_RETRY_MS = 10 * 60 * 1000
// Sources where the model was restored or defaulted rather than chosen: only
// there is putting the pin back silently the right call. After a /clear or a
// compact the person may have switched on purpose, so those get the badge only.
const REAPPLY_ON_START = new Set(['startup', 'resume', 'fork'])
// Who may change the pin: the person, at the terminal (`composer`), through
// Remote Control (`bridge`) or in the desktop app, which hosts its sessions
// over the SDK (`sdk`). A peer session, a channel, a schedule, a task
// notification or another plugin can read it but never move it (the pin
// outlives the session and would steer every later one).
const PIN_EDITORS = new Set(['composer', 'bridge', 'sdk'])
// The switches the optional lock asks about: each is the person's own, from
// /model, the picker, or the desktop app and Remote Control (headless
// set_model arrives as `sdk`). A source the engine adds later passes unasked.
const LOCKED_SOURCES = new Set(['command', 'picker', 'sdk'])

type Dollar = EngineInterface
type Pin = { model: string; from: ModelPinSource }
type Seen = { pin: Pin; isDrift: boolean }

/**
 * The $.store key of this repository's override. The store is one file shared
 * by every session, so the key names the repository's main working tree: a
 * pin set in one checkout holds in its linked worktrees too, as a committed
 * settings.json would. Outside a repository the session root stands in.
 */
const overrideKey = async ($: Dollar) => {
  let root: string | undefined

  try {
    root = (await $.session.repo())?.root
  } catch {
    root = undefined
  }

  return `pin:${root ?? (await $.session.root())}`
}

/**
 * The pin in force: the highest layer that defines a model. A defined but
 * unusable settings value, or a layer that cannot be read, means "no pin"
 * rather than a fall-through: the engine obeys that layer, so pinning a lower
 * one would fight it. Only a malformed override (the mod's own data, which
 * the engine never reads) is skipped.
 */
const getPin = async ($: Dollar, includeUser: boolean): Promise<Pin | undefined> => {
  for (const from of pinLayers(includeUser)) {
    let model: unknown

    try {
      model = from === 'override' ? await $.store.get(await overrideKey($)) : (await $.settings.read({ source: from })).model
    } catch {
      return undefined
    }

    if (model === undefined || model === null || (from === 'override' && !isValidPin(model))) {
      continue
    }

    return isValidPin(model) ? { model, from } : undefined
  }

  return undefined
}

/*
 * Flip a per-session flag to true and say whether this call was the one that
 * did. One function per flag: the state library's update must see the atom as
 * a literal const of this file, so it cannot take the atom as a parameter.
 */
const claimReapply = async ($: Dollar): Promise<boolean> => {
  let won = false

  await update($, reappliedOnce, held => {
    won = !held

    return true
  })

  return won
}

const claimToast = async ($: Dollar): Promise<boolean> => {
  let won = false

  await update($, toastShown, held => {
    won = !held

    return true
  })

  return won
}

/** Takes the fallback retry due at `due`, unless a later fallback has re-armed it. */
const claimRetry = async ($: Dollar, due: number): Promise<boolean> => {
  let won = false

  await update($, retryAt, held => {
    won = held === due

    return won ? 0 : held
  })

  return won
}

const clearBadge = async ($: Dollar) => {
  if (await read($, drifted)) {
    await update($, drifted, () => false)
    await $.ui.status(undefined)
  }
}

/**
 * Compares `current` to the pin and keeps the badge true to it: status line on
 * drift (every time, in case something cleared it), a toast the first time,
 * and the badge cleared once back on the pin. Returns undefined when there is
 * nothing to compare (no pin, no model string, or a pin that cannot be
 * compared), so callers do nothing.
 */
const observe = async ($: Dollar, current: unknown, includeUser: boolean): Promise<Seen | undefined> => {
  if (typeof current !== 'string' || current.trim() === '') {
    return undefined
  }

  const pin = await getPin($, includeUser)

  if (pin === undefined || !isComparable(pin.model)) {
    await clearBadge($)

    return undefined
  }

  if (sameModel(current, pin.model)) {
    await clearBadge($)

    return { pin, isDrift: false }
  }

  await update($, drifted, () => true)
  await $.ui.status(`model drift: ${clip(current)} (pinned ${clip(pin.model)})`)

  if (await claimToast($)) {
    await $.ui.toast(`Model drifted to ${clip(current)}; this project pins ${clip(pin.model)}.`)
  }

  return { pin, isDrift: true }
}

/**
 * Hands the switch to the person: `/model <pin>` filled into an empty composer
 * for one Enter, else named in a toast (`isQuiet` skips the toast for a caller
 * that says it in its own reply). A draft the person is typing is never
 * overwritten. Pressing Enter runs their own /model, so whatever it saves is
 * their choice, not the mod's. Says whether the composer was filled.
 */
const offer = async ($: Dollar, pin: string, isQuiet = false): Promise<boolean> => {
  const command = `/model ${pin}`
  let isFilled = false

  try {
    if ((await $.prompt.read()).text.trim() === '') {
      isFilled = (await $.prompt.fill({ text: command, mode: 'replace' })).isFilled
    }
  } catch {
    // A composer that cannot be read or filled falls to the toast.
  }

  if (!isQuiet) {
    try {
      await $.ui.toast(
        isFilled ? `Press Enter to return to ${clip(pin)}.` : `Model drifted: type ${clip(command, 80)} to return to the pin.`,
      )
    } catch {
      // Nothing left to try; the badge already says the model drifted.
    }
  }

  return isFilled
}

type Handoff = 'queued' | 'filled' | 'unfilled'

/**
 * The person's user-level default as written, when it names `pin` (see
 * silentSwitchArg); undefined otherwise, or when it cannot be read: a default
 * that cannot be shown to match is never switched to on their behalf.
 */
const ownDefault = async ($: Dollar, pin: string): Promise<string | undefined> => {
  try {
    return silentSwitchArg((await $.settings.read({ source: 'user' })).model, pin)
  } catch {
    return undefined
  }
}

/**
 * Starts the move back to `pin`. The built-in /model may save its argument as
 * the person's default for every new session, so the mod queues one itself
 * only when silentSwitchArg allows it (the pin already is that default, and
 * the argument is the default as written); any other pin, wherever it came
 * from, is offered instead. The queued command is not awaited: it runs once
 * the session is idle, and inside a hook the turn waits on it rejects, which
 * is what the .catch is for.
 */
const restore = async ($: Dollar, pin: string, isQuiet = false): Promise<Handoff> => {
  const own = await ownDefault($, pin)

  if (own !== undefined) {
    try {
      // A refusal offers the default as written too, so even the person's
      // own Enter never swaps it for another spelling of the same model.
      $.command.run({ command: 'model', args: own }).catch(() => offer($, own))

      return 'queued'
    } catch {
      // Refused outright: offer it instead.
    }
  }

  return (await offer($, own ?? pin, isQuiet)) ? 'filled' : 'unfilled'
}

/**
 * The one automatic re-apply per session, and the only way any automatic path
 * (a start or resume read, a resume switch, the fallback timer) reaches
 * restore. While an engine fallback waits out its ten minutes (retryAt set),
 * the armed timer owns the re-apply, so a resume or fork in that window must
 * not cut the wait short; the timer clears retryAt before it calls in. The
 * flag is claimed before anything is queued or offered, so two events racing
 * (a resume fires both PostModelSwitch and SessionStart) still make a single
 * attempt.
 */
const reapply = async ($: Dollar, pin: string) => {
  if ((await read($, retryAt)) !== 0 || !(await claimReapply($))) {
    return
  }

  await restore($, pin)
}

/**
 * The retry after an engine fallback, due at `due`: re-check, then re-apply
 * once if still off the pin. Only the timer for the latest fallback acts, so a
 * fresh fallback pushes the retry back rather than being undone a minute in;
 * a timer armed twice (a reload re-arm racing the original) acts once.
 */
const retryAfterFallback = async ($: Dollar, due: number, includeUser: boolean) => {
  try {
    if (!(await claimRetry($, due)) || (await read($, reappliedOnce))) {
      return
    }

    const seen = await observe($, await $.session.model(), includeUser)

    if (seen?.isDrift) {
      await reapply($, seen.pin.model)
    }
  } catch {
    // A failed retry leaves the badge as it was.
  }
}

/** Arms the fallback retry for `due`. The due time lives in $.state, so a reload can arm it again. */
const armRetry = async ($: Dollar, due: number, includeUser: boolean) => {
  const wait = Math.max(0, due - (await $.clock.now()))

  $.clock.after(wait, () => void retryAfterFallback($, due, includeUser))
}

/**
 * Swaps an alias override (`fable`) for the resolved id a switch to that very
 * alias landed on, so later comparisons are like for like and survive the CLI
 * re-pointing the alias. A switch the person asked for by another name (a
 * one-off `/model claude-opus-4-1` under an `opus` pin) never re-pins.
 */
const resolveOverride = async ($: Dollar, resolved: string, requested: string | null, stored: string) => {
  const alias = normalizeModel(stored)

  if (
    isAlias(alias) &&
    isComparable(stored) &&
    requested !== null &&
    normalizeModel(requested) === alias &&
    isValidPin(resolved) &&
    sameModel(resolved, stored)
  ) {
    // The store is shared with every session on this repository and has no
    // compare-and-swap: read again right before writing, so a /model-pin clear
    // or a new pin from another session since this hook's first read stands.
    const key = await overrideKey($)

    if ((await $.store.get(key)) === stored) {
      await $.store.set(key, resolved)
    }
  }
}

/** A new or cleared pin starts the session's drift bookkeeping afresh. */
const resetSession = async ($: Dollar) => {
  await update($, reappliedOnce, () => false)
  await update($, toastShown, () => false)
  await update($, retryAt, () => 0)
  await clearBadge($)
}

/** The session's model, or undefined when it cannot be read (before one resolves). */
const readModel = async ($: Dollar): Promise<string | undefined> => {
  try {
    const model: unknown = await $.session.model()

    return typeof model === 'string' && model.trim() !== '' ? model : undefined
  } catch {
    return undefined
  }
}

const describe = async ($: Dollar, includeUser: boolean): Promise<string> => {
  const pin = await getPin($, includeUser)
  const current = await readModel($)
  const session = current === undefined ? "The session's model is not known yet" : `Session is on ${clip(current)}`

  if (pin === undefined) {
    return `No model pin for this project. ${session}. Set one with /model-pin <model>, or "model" in .claude/settings.json.`
  }

  if (!isComparable(pin.model)) {
    return `Pinned to ${clip(pin.model)} (${pin.from}), a name that cannot be checked against the session's model, so drift is not tracked. ${session}.`
  }

  if (current === undefined) {
    return `Pinned to ${clip(pin.model)} (${pin.from}). ${session}.`
  }

  const state = sameModel(current, pin.model) ? 'on the pin' : 'DRIFTED'

  return `Pinned to ${clip(pin.model)} (${pin.from}). ${session}: ${state}.`
}

export const register: Register = (on, options) => {
  const includeUser = options.includeUserSettings === true

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'model-pin',
        description: 'Pin this project to a model, clear the pin, or show it',
        argumentHint: '[model|clear]',
      })
    } catch {
      // The pin and drift badge work without the command.
    }

    try {
      await observe($, await $.session.model(), includeUser)
    } catch {
      // Observer: never block the session from starting.
    }

    // session.start runs again after a reload, which drops timers: put back a
    // fallback retry that was still waiting.
    try {
      const due = await read($, retryAt)

      if (due > 0 && !(await read($, reappliedOnce))) {
        await armRetry($, due, includeUser)
      }
    } catch {
      // Without the retry the badge still shows; the person can /model back.
    }

    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    // A subagent's events are its own: the pin and the badge are the main
    // session's.
    if (e.agent_id !== undefined) {
      return next(e)
    }

    try {
      const seen = await observe($, await $.session.model(), includeUser)

      // A session started as an agent runs that agent's own model on purpose:
      // badge only, never a switch. (A waiting fallback retry is checked in
      // reapply, as it is for every automatic path.)
      if (seen?.isDrift && REAPPLY_ON_START.has(e.source) && e.agent_type === undefined) {
        await reapply($, seen.pin.model)
      }
    } catch {
      // Observer: never block the session from starting.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Observers that fail open: if a hook throws past its own try, the .catch
  // replays what is beneath, so a broken pin can never stop a start or a switch.
  on('classic.PostModelSwitch', async ($, e, next) => {
    // A subagent's own switch (its fallback, say) is not the main session's
    // model: it must not badge, toast or arm the retry.
    if (e.agent_id !== undefined) {
      return next(e)
    }

    try {
      const seen = await observe($, e.to_model, includeUser)

      if (seen?.isDrift && e.source === 'resume') {
        await reapply($, seen.pin.model)
      } else if (seen?.isDrift && e.source === 'auto') {
        // Every fallback restarts the wait, so the retry comes ten minutes
        // after the latest one, never sooner.
        if (!(await read($, reappliedOnce))) {
          const due = (await $.clock.now()) + AUTO_RETRY_MS

          await update($, retryAt, () => due)
          await armRetry($, due, includeUser)
        }
      } else if (seen?.pin.from === 'override' && e.source === 'command') {
        await resolveOverride($, e.to_model, e.requested_model, seen.pin.model)
      }
    } catch {
      // Observer: a failed check must never block or undo a model switch.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Optional lock: ask before a deliberate switch away from the pin. 'ask',
  // never 'deny', so the person can still go on purpose. An observer that
  // fails open: if this hook throws, the switch proceeds unasked. The ask
  // replaces an 'allow' from a hook beneath (another plugin's) on purpose: the
  // lock is the person's own setting and asking is the stricter answer, so it
  // fails safe; a 'deny' beneath is kept as it is.
  on('classic.PreModelSwitch', async ($, e, next) => {
    const ran = await next(e)

    if (options.lock !== true || ran.permissionDecision === 'deny' || e.agent_id !== undefined) {
      return ran
    }

    if (!LOCKED_SOURCES.has(e.source)) {
      return ran
    }

    const pin = await getPin($, includeUser)

    // A pin that cannot be compared would ask on every switch, its own included.
    if (pin === undefined || !isComparable(pin.model) || sameModel(e.to_model, pin.model)) {
      return ran
    }

    if (e.requested_model !== null && normalizeModel(e.requested_model) === normalizeModel(pin.model)) {
      return ran
    }

    return {
      ...ran,
      permissionDecision: 'ask',
      permissionDecisionReason: `project pins ${clip(pin.model)}`,
    }
  }).catch(($, e, next) => next(e))

  // This hook answers its own command, so a throw would reach the person as a
  // hook error rather than a reply: every failure ends as a plain message
  // instead (never the raw error, which could carry a path or a value).
  on('command.run', { command: 'model-pin' }, async ($, e) => {
    try {
      const arg = e.args.trim()

      if (arg === '') {
        return { text: await describe($, includeUser) }
      }

      // Reading the pin is harmless from anywhere; changing it is the person's alone.
      if (!PIN_EDITORS.has(e.origin?.kind)) {
        return { text: 'Only you can change the model pin: type /model-pin at the prompt.' }
      }

      const key = await overrideKey($)

      if (arg.toLowerCase() === 'clear') {
        await $.store.delete(key)
        await resetSession($)
        const left = await getPin($, includeUser)

        return {
          text:
            left === undefined
              ? 'Model pin cleared for this project.'
              : `Override cleared. This project is still pinned to ${clip(left.model)} by its ${left.from} settings.`,
        }
      }

      if (!isValidPin(arg)) {
        return { text: 'Give one model id or alias, for example /model-pin claude-fable-5-1, or "clear".' }
      }

      // Stored as typed first so the optional lock lets the switch to it
      // through; PostModelSwitch then swaps an alias for the resolved id it
      // lands on.
      await $.store.set(key, arg)
      await resetSession($)

      const pin = await getPin($, includeUser)

      if (pin?.from !== 'override') {
        return {
          text:
            pin === undefined
              ? `Saved ${clip(arg)} for this project, but it is not in force: a settings source could not be read.`
              : `Saved ${clip(arg)} for this project, but its ${pin.from} settings pin ${clip(pin.model)} and take precedence here.`,
        }
      }

      const pinned = `Pinned this project to ${clip(arg)}.`
      const unchecked = isComparable(arg) ? '' : ' That name cannot be checked against the session model, so drift will not be tracked.'
      const current = await readModel($)

      if (current !== undefined && sameModel(current, arg)) {
        if (isValidPin(current)) {
          await $.store.set(key, current)
        }

        return { text: `${pinned} The session is already on it.${unchecked}` }
      }

      // The override is never the person's default, unless their user
      // settings already name it, so the switch is usually offered, not run.
      const handoff = await restore($, arg, true)

      // Queued, not yet run: from inside this hook the engine may refuse it,
      // and then the offer (a fill or a toast) says so after this reply. So
      // the reply claims only the queueing, never a switch.
      if (handoff === 'queued') {
        return {
          text: `${pinned} It is your own default, so /model is queued to switch the session; if it cannot run from here, it is offered at the prompt instead.${unchecked}`,
        }
      }

      return {
        text:
          handoff === 'filled'
            ? `${pinned} Press Enter on the /model line in the prompt to switch the session to it.${unchecked}`
            : `${pinned} Type ${clip(`/model ${arg}`, 80)} to switch the session to it.${unchecked}`,
      }
    } catch {
      return { text: 'model-pin could not finish. Run /model-pin to see where the pin stands.' }
    }
  })
}
