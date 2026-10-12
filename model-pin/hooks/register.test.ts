import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { isComparable, isValidPin, normalizeModel, sameModel, silentSwitchArg } from './pin'

// The kit's environment has timers; the no-DOM typings do not name them.
declare const setTimeout: (callback: (value?: unknown) => void, ms: number) => unknown

const FABLE = 'claude-fable-5-1'
const SONNET = 'claude-sonnet-5-5'
const TEN_MINUTES = 10 * 60 * 1000

type PreSource = 'command' | 'picker' | 'sdk'
type Source = PreSource | 'auto' | 'resume'
type SourceName = 'policy' | 'flag' | 'local' | 'project' | 'user'
type Settings = Partial<Record<SourceName, Record<string, unknown>>>

type World = {
  statuses: (string | undefined)[]
  toasts: string[]
  switches: string[]
  fills: string[]
  registered: string[]
  store: Record<string, unknown>
  clock: ReturnType<typeof mock.clock>
  // With handClock: every timer armed, by its wait, fired only when the test says.
  timers: { ms: number; fire: () => void }[]
}

type WorldOptions = {
  model?: string
  settings?: Settings
  store?: Record<string, unknown>
  draft?: string
  // A clock the test drives by hand instead of the kit's, so it can fire one
  // timer and leave another, as a reload drops the old environment's timers.
  handClock?: { now: number }
  // The queued /model is refused, as it is inside a hook the turn waits on.
  isSwitchRefused?: boolean
  isSettingsBroken?: boolean
  // Only these sources throw when read, as an unreadable file would.
  brokenSources?: SourceName[]
  isModelUnreadable?: boolean
  // The main working tree's root, as $.session.repo() answers it; no repo when left out.
  repoRoot?: string
  // What a PreModelSwitch hook beneath (another plugin's) answers.
  beneathPre?: { permissionDecision?: 'allow' | 'deny' | 'ask' }
  // Another session on the same repository writes the key just read, right
  // after the plugin's read number `afterReads` (value undefined: a clear).
  otherSession?: { afterReads: number; value?: unknown }
}

/**
 * Stands in for everything beneath the plugin: the session, settings, store,
 * clock, composer and the commands it queues. What the plugin wrote to the
 * display or queued is recorded on the returned world for the test to assert.
 */
const world = (on: On, options: WorldOptions = {}): World & { model: { current: string } } => {
  const seen: World = {
    statuses: [],
    toasts: [],
    switches: [],
    fills: [],
    registered: [],
    store: { ...options.store },
    clock: undefined as unknown as World['clock'],
    timers: [],
  }
  const hand = options.handClock

  if (hand === undefined) {
    seen.clock = mock.clock(on)
  } else {
    on('clock.now', () => ({ value: hand.now }))
    on('clock.after', (_$, e) => new Promise(resolve => {
      seen.timers.push({ ms: e.ms, fire: () => resolve({ value: undefined }) })
    }))
  }
  const model = { current: options.model ?? FABLE }
  // A store in a plain object, so a test can read back what the plugin wrote
  // (the engine's `$` in a test has no store noun to call).
  let reads = 0
  on('store.get', (_$, e) => {
    const value = seen.store[e.key]
    const other = options.otherSession
    reads += 1

    if (other !== undefined && reads === other.afterReads) {
      if (other.value === undefined) {
        delete seen.store[e.key]
      } else {
        seen.store[e.key] = other.value
      }
    }

    return { value }
  })
  on('store.set', (_$, e) => {
    seen.store[e.key] = e.value

    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete seen.store[e.key]

    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(seen.store) }))

  on('session.root', () => ({ value: '/repo' }))
  on('session.repo', () => ({
    value: options.repoRoot === undefined ? null : { root: options.repoRoot, remote: null, internal: false, name: null },
  }))
  on('session.model', () => {
    if (options.isModelUnreadable) {
      throw new Error('no model yet')
    }

    return { value: model.current }
  })
  on('settings.read', (_$, e) => {
    if (options.isSettingsBroken || options.brokenSources?.includes(e.source as SourceName)) {
      throw new Error('settings unreadable')
    }

    return { value: options.settings?.[e.source as SourceName] ?? {} }
  })
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: options.draft ?? '', cursor: 0 } }))
  on('prompt.fill', (_$, e) => {
    seen.fills.push(e.text)

    return { isFilled: true }
  })
  on('command.register', (_$, e) => {
    seen.registered.push(e.name)

    return { value: { command: e.name } }
  })

  if (!options.isSwitchRefused) {
    on('command.run', { command: 'model' }, (_$, e) => {
      seen.switches.push(e.args)

      return { text: '' }
    })
  }

  on('classic.PostModelSwitch', () => ({}))
  on('classic.PreModelSwitch', () => ({ ...options.beneathPre }))
  on('classic.SessionStart', () => ({}))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  return Object.assign(seen, { model })
}

const switched = <S extends Source>(to_model: string, source: S, requested_model: string | null = null) => ({
  from_model: FABLE,
  to_model,
  requested_model,
  source,
  context_tokens: 0,
  prompt_cache_warm: false,
  cache_ttl: '5m' as const,
  estimated_cache_write_usd: 0,
  pricing: 'catalog' as const,
})

const pinnedByProject: Settings = { project: { model: FABLE } }
// The project pins the person's own default: the one case where the mod may
// run /model itself, since saving the pin as the default changes nothing.
const pinnedAsDefault: Settings = { project: { model: FABLE }, user: { model: FABLE } }

// The queued /model either runs or, when the engine refuses it inside a hook the
// turn waits on, lands in the composer: either way it is one re-apply attempt.
const attempts = (seen: World) => seen.switches.length + seen.fills.length

const lastStatus = (seen: World) => seen.statuses[seen.statuses.length - 1]

describe('comparing a pin to the session model', () => {
  test('an alias, a resolved id, a display name and a provider id are one model', () => {
    expect(sameModel('fable', FABLE)).toBe(true)
    expect(sameModel('Fable 5.1', FABLE)).toBe(true)
    expect(sameModel('us.anthropic.claude-opus-4-1-20250805-v1:0', 'claude-opus-4-1')).toBe(true)
    expect(sameModel('anthropic/claude-opus-4@20250514', 'opus-4')).toBe(true)
    expect(sameModel('opus[1m]', 'claude-opus-5-5')).toBe(true)
    expect(normalizeModel('  Claude-Fable-5-1  ')).toBe('fable-5-1')
  })

  test('different versions or families, and empty strings, are not the same model', () => {
    expect(sameModel(FABLE, SONNET)).toBe(false)
    expect(sameModel('claude-opus-4-1', 'claude-opus-4')).toBe(false)
    expect(sameModel('opus', FABLE)).toBe(false)
    expect(sameModel('', FABLE)).toBe(false)
    expect(sameModel('', '')).toBe(false)
  })

  test('only a pin naming a known family or a full id can be compared', () => {
    expect(isComparable(FABLE)).toBe(true)
    expect(isComparable('fable')).toBe(true)
    expect(isComparable('opus[1m]')).toBe(true)
    expect(isComparable('opusplan')).toBe(false)
    expect(isComparable('default')).toBe(false)
    expect(isComparable('Default (recommended)')).toBe(false)
    expect(isComparable('arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc')).toBe(false)
  })

  test('the mod may run /model itself only with the person\'s own default, as written', () => {
    expect(silentSwitchArg(FABLE, FABLE)).toBe(FABLE)
    // Equal once normalized: the default goes out byte for byte, so saving it changes nothing.
    expect(silentSwitchArg('us.anthropic.claude-fable-5-1-v1:0', FABLE)).toBe('us.anthropic.claude-fable-5-1-v1:0')
    expect(silentSwitchArg('Claude-Fable-5-1', FABLE)).toBe('Claude-Fable-5-1')
    // Another model, no default, a mere family match or a malformed value: never.
    expect(silentSwitchArg(SONNET, FABLE)).toBeUndefined()
    expect(silentSwitchArg(undefined, FABLE)).toBeUndefined()
    expect(silentSwitchArg('fable', FABLE)).toBeUndefined()
    expect(silentSwitchArg(FABLE, 'fable')).toBeUndefined()
    expect(silentSwitchArg('opus\n/exit', 'opus\n/exit')).toBeUndefined()
    expect(silentSwitchArg(42, FABLE)).toBeUndefined()
  })

  test('a silent switch never adds or drops a [1m]-style variant, which can change pricing', () => {
    expect(silentSwitchArg(`${FABLE}[1m]`, FABLE)).toBeUndefined()
    expect(silentSwitchArg(FABLE, `${FABLE}[1m]`)).toBeUndefined()
    expect(silentSwitchArg(`${FABLE}[1M]`, `${FABLE}[1m]`)).toBe(`${FABLE}[1M]`)
    // The badge still treats the variants as one model.
    expect(sameModel(`${FABLE}[1m]`, FABLE)).toBe(true)
  })

  test('a pin that could smuggle text into /model or the composer is refused', () => {
    expect(isValidPin(FABLE)).toBe(true)
    expect(isValidPin('opus[1m]')).toBe(true)
    expect(isValidPin('opus\n/exit')).toBe(false)
    expect(isValidPin('opus && rm -rf /')).toBe(false)
    expect(isValidPin('')).toBe(false)
    expect(isValidPin(42)).toBe(false)
    expect(isValidPin('a'.repeat(101))).toBe(false)
  })
})

describe('drift detection', () => {
  test('a switch away from the pin shows the badge and one toast, and going back clears it', async ($, on) => {
    const seen = world(on, { settings: pinnedByProject })

    await $.classic.PostModelSwitch(switched(SONNET, 'command', 'sonnet'))
    expect(lastStatus(seen)).toBe(`model drift: ${SONNET} (pinned ${FABLE})`)
    expect(seen.toasts).toHaveLength(1)
    // A deliberate switch is shown, never fought.
    expect(seen.switches).toHaveLength(0)

    await $.classic.PostModelSwitch(switched('claude-haiku-5-0', 'picker'))
    expect(seen.toasts).toHaveLength(1)

    await $.classic.PostModelSwitch(switched(FABLE, 'command', 'fable'))
    expect(lastStatus(seen)).toBeUndefined()
  })

  test('a pin written as an alias does not read as drift on its resolved id', async ($, on) => {
    const seen = world(on, { settings: { project: { model: 'fable' } } })

    await $.classic.PostModelSwitch(switched(FABLE, 'resume'))
    expect(seen.statuses).toHaveLength(0)
    expect(seen.toasts).toHaveLength(0)
    expect(seen.switches).toHaveLength(0)
  })

  test('local settings beat project settings, as the engine reads them', async ($, on) => {
    const seen = world(on, { settings: { project: { model: FABLE }, local: { model: SONNET } }, model: SONNET })

    await $.classic.SessionStart({ source: 'startup' })
    await $.classic.PostModelSwitch(switched(SONNET, 'resume'))
    await seen.clock.settle()
    expect(seen.statuses).toHaveLength(0)
    expect(seen.toasts).toHaveLength(0)
    expect(attempts(seen)).toBe(0)
  })

  test('managed policy and --settings beat every file, so the mod never fights them', async ($, on) => {
    const seen = world(on, {
      settings: { policy: { model: SONNET }, flag: { model: FABLE }, local: { model: FABLE }, project: { model: FABLE } },
      model: SONNET,
    })

    await $.classic.SessionStart({ source: 'startup' })
    await seen.clock.settle()
    expect(seen.statuses).toHaveLength(0)
    expect(attempts(seen)).toBe(0)
  })

  test('a --settings model beats local and project settings', async ($, on) => {
    const seen = world(on, { settings: { flag: { model: SONNET }, project: { model: FABLE } }, model: SONNET })

    await $.classic.SessionStart({ source: 'startup' })
    await seen.clock.settle()
    expect(attempts(seen)).toBe(0)
  })

  test('a user-level model is not a pin unless the person opts in', async ($, on) => {
    const seen = world(on, { settings: { user: { model: FABLE } }, model: SONNET })

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'startup' })
    await seen.clock.settle()
    // A session started on a cheaper model on purpose stays there.
    expect(seen.statuses).toHaveLength(0)
    expect(attempts(seen)).toBe(0)
  })

  test('opted in, a user-level model pins projects that set none', { options: { includeUserSettings: true } }, async ($, on) => {
    const seen = world(on, { settings: { user: { model: FABLE } }, model: SONNET })

    await $.classic.SessionStart({ source: 'startup' })
    await seen.clock.settle()
    expect(lastStatus(seen)).toBe(`model drift: ${SONNET} (pinned ${FABLE})`)
    expect(seen.switches).toEqual([FABLE])
  })

  test('opted in, project settings still beat the user-level model', { options: { includeUserSettings: true } }, async ($, on) => {
    const seen = world(on, { settings: { project: { model: SONNET }, user: { model: FABLE } }, model: SONNET })

    await $.classic.SessionStart({ source: 'startup' })
    await seen.clock.settle()
    expect(attempts(seen)).toBe(0)
  })

  test('a higher source that cannot be read pins nothing rather than falling to a lower one', async ($, on) => {
    const seen = world(on, { settings: { project: { model: FABLE } }, brokenSources: ['local'], model: SONNET })

    await $.classic.SessionStart({ source: 'startup' })
    await seen.clock.settle()
    expect(seen.statuses).toHaveLength(0)
    expect(attempts(seen)).toBe(0)
  })

  test('a lower source that cannot be read does not matter once a higher one pins', async ($, on) => {
    const seen = world(on, { settings: { local: { model: FABLE } }, brokenSources: ['project', 'user'], model: SONNET })

    await $.classic.PostModelSwitch(switched(SONNET, 'command'))
    expect(lastStatus(seen)).toBe(`model drift: ${SONNET} (pinned ${FABLE})`)
  })

  test('a pin that cannot be compared (opusplan, default, an ARN) never badges or re-applies', async ($, on) => {
    const seen = world(on, { settings: { project: { model: 'opusplan' } }, model: 'claude-opus-5-5' })

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'startup' })
    await $.classic.PostModelSwitch(switched('claude-opus-5-5', 'resume'))
    await seen.clock.settle()
    expect(seen.statuses).toHaveLength(0)
    expect(seen.toasts).toHaveLength(0)
    expect(attempts(seen)).toBe(0)
  })

  test('a defined but unusable model pins nothing and does not fall through to user settings', { options: { includeUserSettings: true } }, async ($, on) => {
    const seen = world(on, { settings: { project: { model: 'opus\n/exit' }, user: { model: FABLE } } })

    await $.classic.PostModelSwitch(switched(SONNET, 'command'))
    expect(seen.statuses).toHaveLength(0)
  })

  test('session start reads the model once and shows drift', async ($, on) => {
    const seen = world(on, { settings: pinnedByProject, model: SONNET })

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(seen.registered).toEqual(['model-pin'])
    expect(lastStatus(seen)).toBe(`model drift: ${SONNET} (pinned ${FABLE})`)
    // session.start never re-applies: it has no source to judge the drift by.
    expect(seen.switches).toHaveLength(0)
  })

  test('no pin anywhere means no badge, toast or switch', async ($, on) => {
    const seen = world(on, { model: SONNET })

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'resume' })
    await $.classic.PostModelSwitch(switched(SONNET, 'resume'))
    await $.classic.PostModelSwitch(switched(SONNET, 'auto'))
    await seen.clock.advance(TEN_MINUTES * 2)

    expect(seen.statuses).toHaveLength(0)
    expect(seen.toasts).toHaveLength(0)
    expect(seen.switches).toHaveLength(0)
    expect(seen.fills).toHaveLength(0)
  })
})

describe('re-applying the pin', () => {
  test('a resume and a drifted startup read re-apply once between them', async ($, on) => {
    const seen = world(on, { settings: pinnedByProject, model: SONNET })

    await $.classic.PostModelSwitch(switched(SONNET, 'resume'))
    await $.classic.SessionStart({ source: 'resume' })
    await $.classic.PostModelSwitch(switched(SONNET, 'resume'))
    await seen.clock.settle()

    expect(attempts(seen)).toBe(1)
  })

  test('a startup read re-applies but a clear or compact only shows the badge', async ($, on) => {
    const cleared = world(on, { settings: pinnedAsDefault, model: SONNET })

    await $.classic.SessionStart({ source: 'clear' })
    await $.classic.SessionStart({ source: 'compact' })
    expect(cleared.switches).toHaveLength(0)
    expect(lastStatus(cleared)).toBe(`model drift: ${SONNET} (pinned ${FABLE})`)

    await $.classic.SessionStart({ source: 'startup' })
    await cleared.clock.settle()
    expect(cleared.switches).toEqual([FABLE])
  })

  test('a session started as an agent keeps its own model: badge only', async ($, on) => {
    const seen = world(on, { settings: pinnedByProject, model: SONNET })

    await $.classic.SessionStart({ source: 'startup', agent_type: 'builder' })
    await seen.clock.settle()
    expect(lastStatus(seen)).toBe(`model drift: ${SONNET} (pinned ${FABLE})`)
    expect(attempts(seen)).toBe(0)
  })

  test('a refused /model falls back to filling an empty draft', async ($, on) => {
    const seen = world(on, { settings: pinnedAsDefault, model: SONNET, isSwitchRefused: true })

    await $.classic.PostModelSwitch(switched(SONNET, 'resume'))
    await seen.clock.settle()

    expect(seen.fills).toEqual([`/model ${FABLE}`])
  })

  test('a refused /model never overwrites a draft the person is typing', async ($, on) => {
    const seen = world(on, {
      settings: pinnedAsDefault,
      model: SONNET,
      isSwitchRefused: true,
      draft: 'fix the login bug',
    })

    await $.classic.PostModelSwitch(switched(SONNET, 'resume'))
    await seen.clock.settle()

    expect(seen.fills).toHaveLength(0)
    expect(seen.toasts.some(text => text.includes(`/model ${FABLE}`))).toBe(true)
  })

  test('an engine fallback gets the badge now and one re-apply after ten minutes', async ($, on) => {
    const seen = world(on, { settings: pinnedAsDefault, model: SONNET })

    await $.classic.PostModelSwitch(switched(SONNET, 'auto'))
    await $.classic.PostModelSwitch(switched(SONNET, 'auto'))
    expect(lastStatus(seen)).toBe(`model drift: ${SONNET} (pinned ${FABLE})`)
    expect(seen.switches).toHaveLength(0)

    await seen.clock.advance(TEN_MINUTES - 1)
    expect(seen.switches).toHaveLength(0)

    await seen.clock.advance(1)
    await seen.clock.settle()
    expect(seen.switches).toEqual([FABLE])
  })

  test('a second fallback restarts the wait: the retry comes ten minutes after the latest one', async ($, on) => {
    const seen = world(on, { settings: pinnedAsDefault, model: SONNET })

    await $.classic.PostModelSwitch(switched(SONNET, 'auto'))
    await seen.clock.advance(TEN_MINUTES - 60_000)
    await $.classic.PostModelSwitch(switched(SONNET, 'auto'))

    // The first timer comes due here, a minute after the fresh fallback: it stands down.
    await seen.clock.advance(60_000)
    await seen.clock.settle()
    expect(seen.switches).toHaveLength(0)

    await seen.clock.advance(TEN_MINUTES - 60_000)
    await seen.clock.settle()
    expect(seen.switches).toEqual([FABLE])
  })

  test('a reload re-arm and the timer it replaces act once between them', async ($, on) => {
    const seen = world(on, { settings: pinnedAsDefault, model: SONNET })

    await $.classic.PostModelSwitch(switched(SONNET, 'auto'))
    await seen.clock.advance(TEN_MINUTES / 2)
    // session.start runs again after a hot reload, which drops the old timer,
    // and arms one for what is left of the wait. The kit cannot drop a timer,
    // so the old one survives here: what this proves is that the two, both due
    // at once, never re-apply twice and never early.
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

    await seen.clock.advance(TEN_MINUTES / 2 - 1)
    expect(seen.switches).toHaveLength(0)

    await seen.clock.advance(1)
    await seen.clock.settle()
    expect(seen.switches).toEqual([FABLE])

    await seen.clock.advance(TEN_MINUTES * 2)
    expect(seen.switches).toEqual([FABLE])
  })

  test('after a reload drops the timer, the re-armed one alone re-applies, on the original schedule', async ($, on) => {
    const time = { now: 0 }
    const seen = world(on, { settings: pinnedAsDefault, model: SONNET, handClock: time })

    await $.classic.PostModelSwitch(switched(SONNET, 'auto'))
    expect(seen.timers.map(timer => timer.ms)).toEqual([TEN_MINUTES])

    // Four minutes on, a reload: the first timer is never fired (dropped).
    time.now = 4 * 60 * 1000
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(seen.timers.map(timer => timer.ms)).toEqual([TEN_MINUTES, 6 * 60 * 1000])

    time.now = TEN_MINUTES
    seen.timers[1]?.fire()
    // The fired timer's work runs off the test's await chain: give it a beat.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(seen.switches).toEqual([FABLE])
  })

  test('a resume or fork while a fallback waits leaves the re-apply to the timer', async ($, on) => {
    const seen = world(on, { settings: pinnedAsDefault, model: SONNET })

    await $.classic.PostModelSwitch(switched(SONNET, 'auto'))
    await $.classic.SessionStart({ source: 'resume' })
    await $.classic.SessionStart({ source: 'fork' })
    await seen.clock.settle()
    expect(attempts(seen)).toBe(0)

    await seen.clock.advance(TEN_MINUTES)
    await seen.clock.settle()
    expect(seen.switches).toEqual([FABLE])
  })

  // A resume fires PostModelSwitch(resume) as well as SessionStart: neither
  // entry point may cut the wait short.
  for (const [name, settings] of [['the person\'s default', pinnedAsDefault], ['a project pin', pinnedByProject]] as const) {
    test(`a resume switch one minute into a fallback wait leaves ${name} to the timer`, async ($, on) => {
      const seen = world(on, { settings, model: SONNET })

      await $.classic.PostModelSwitch(switched(SONNET, 'auto'))
      await seen.clock.advance(60 * 1000)
      await $.classic.PostModelSwitch(switched(SONNET, 'resume'))
      await $.classic.SessionStart({ source: 'resume' })
      await seen.clock.settle()
      expect(attempts(seen)).toBe(0)

      await seen.clock.advance(TEN_MINUTES - 60 * 1000)
      await seen.clock.settle()
      expect(attempts(seen)).toBe(1)

      // Spent: a later resume, after the wait, does not try again.
      await $.classic.PostModelSwitch(switched(SONNET, 'resume'))
      await seen.clock.settle()
      expect(attempts(seen)).toBe(1)
    })
  }

  test('a subagent\'s own start or switch never badges, toasts or re-applies', async ($, on) => {
    const seen = world(on, { settings: pinnedAsDefault, model: SONNET })

    await $.classic.SessionStart({ source: 'startup', agent_id: 'sub-1', agent_type: 'builder' })
    await $.classic.PostModelSwitch({ ...switched(SONNET, 'resume'), agent_id: 'sub-1' })
    await $.classic.PostModelSwitch({ ...switched(SONNET, 'auto'), agent_id: 'sub-1' })
    await seen.clock.advance(TEN_MINUTES * 2)
    await seen.clock.settle()

    expect(seen.statuses).toHaveLength(0)
    expect(seen.toasts).toHaveLength(0)
    expect(attempts(seen)).toBe(0)
  })

  test('the retry stands down when the engine has already come back to the pin', async ($, on) => {
    const seen = world(on, { settings: pinnedByProject, model: SONNET })

    await $.classic.PostModelSwitch(switched(SONNET, 'auto'))
    seen.model.current = FABLE
    await seen.clock.advance(TEN_MINUTES)
    await seen.clock.settle()

    expect(seen.switches).toHaveLength(0)
    expect(lastStatus(seen)).toBeUndefined()
  })
})

// The built-in /model may save its argument as the default for new sessions,
// so the mod runs it only when the pin already is the person's user-level
// default. Any other pin is offered in the composer (or named in a toast).
describe('never moving the person\'s default model', () => {
  for (const layer of ['policy', 'flag', 'local', 'project'] as const) {
    test(`a ${layer} pin that is not the person's default is offered at startup, never run`, async ($, on) => {
      const settings: Settings = { user: { model: SONNET } }
      settings[layer] = { model: FABLE }
      const seen = world(on, { settings, model: SONNET })

      await $.classic.SessionStart({ source: 'startup' })
      await seen.clock.settle()
      expect(seen.switches).toEqual([])
      expect(seen.fills).toEqual([`/model ${FABLE}`])
      expect(seen.toasts).toContain(`Press Enter to return to ${FABLE}.`)
    })
  }

  test('an override pin is offered at startup, never run, even with no user default', async ($, on) => {
    const seen = world(on, { model: SONNET, store: { 'pin:/repo': FABLE } })

    await $.classic.SessionStart({ source: 'startup' })
    await seen.clock.settle()
    expect(seen.switches).toEqual([])
    expect(seen.fills).toEqual([`/model ${FABLE}`])
  })

  test('a project pin restored on resume is offered, never run', async ($, on) => {
    const seen = world(on, { settings: pinnedByProject, model: SONNET })

    await $.classic.PostModelSwitch(switched(SONNET, 'resume'))
    await seen.clock.settle()
    expect(seen.switches).toEqual([])
    expect(seen.fills).toEqual([`/model ${FABLE}`])
  })

  test('the fallback retry offers a project pin that is not the person\'s default', async ($, on) => {
    const seen = world(on, { settings: { project: { model: FABLE }, user: { model: SONNET } }, model: SONNET })

    await $.classic.PostModelSwitch(switched(SONNET, 'auto'))
    await seen.clock.advance(TEN_MINUTES)
    await seen.clock.settle()
    expect(seen.switches).toEqual([])
    expect(seen.fills).toEqual([`/model ${FABLE}`])
  })

  test('a user default that cannot be read means offer, never run', async ($, on) => {
    const seen = world(on, { settings: pinnedByProject, brokenSources: ['user'], model: SONNET })

    await $.classic.SessionStart({ source: 'startup' })
    await seen.clock.settle()
    expect(seen.switches).toEqual([])
    expect(seen.fills).toEqual([`/model ${FABLE}`])
  })

  test('an offer never overwrites a draft: it names the command in a toast', async ($, on) => {
    const seen = world(on, { settings: pinnedByProject, model: SONNET, draft: 'fix the login bug' })

    await $.classic.SessionStart({ source: 'startup' })
    await seen.clock.settle()
    expect(seen.switches).toEqual([])
    expect(seen.fills).toEqual([])
    expect(seen.toasts.some(text => text.includes(`type /model ${FABLE}`))).toBe(true)
  })

  test('a pin equal to the person\'s default runs /model with that default as written', async ($, on) => {
    const own = 'us.anthropic.claude-fable-5-1-v1:0'
    const seen = world(on, { settings: { project: { model: FABLE }, user: { model: own } }, model: SONNET })

    await $.classic.SessionStart({ source: 'startup' })
    await seen.clock.settle()
    expect(seen.switches).toEqual([own])
    expect(seen.fills).toEqual([])
  })

  test('a default that differs only by a [1m] variant is offered, never run', async ($, on) => {
    const seen = world(on, { settings: { project: { model: FABLE }, user: { model: `${FABLE}[1m]` } }, model: SONNET })

    await $.classic.SessionStart({ source: 'startup' })
    await seen.clock.settle()
    expect(seen.switches).toEqual([])
    expect(seen.fills).toEqual([`/model ${FABLE}`])
  })

  test('a refused switch to the person\'s default offers that default as written', async ($, on) => {
    const own = 'us.anthropic.claude-fable-5-1-v1:0'
    const seen = world(on, {
      settings: { project: { model: FABLE }, user: { model: own } },
      model: SONNET,
      isSwitchRefused: true,
    })

    await $.classic.SessionStart({ source: 'startup' })
    await seen.clock.settle()
    expect(seen.fills).toEqual([`/model ${own}`])
  })
})

describe('the optional lock', () => {
  const ask = (source: PreSource = 'command', to_model = SONNET, requested: string | null = 'sonnet') =>
    switched(to_model, source, requested)

  test('off by default: a switch away from the pin goes through unasked', async ($, on) => {
    world(on, { settings: pinnedByProject })

    const ran = await $.classic.PreModelSwitch(ask())
    expect(ran.permissionDecision).toBeUndefined()
  })

  test('on: a command or picker switch away from the pin asks, naming the pin', { options: { lock: true } }, async ($, on) => {
    world(on, { settings: pinnedByProject })

    const ran = await $.classic.PreModelSwitch(ask())
    expect(ran.permissionDecision).toBe('ask')
    expect(ran.permissionDecisionReason).toBe(`project pins ${FABLE}`)
    expect((await $.classic.PreModelSwitch(ask('picker', 'claude-haiku-5-0', null))).permissionDecision).toBe('ask')
  })

  test('on: switching to the pin and a pinned alias never ask', { options: { lock: true } }, async ($, on) => {
    world(on, { settings: pinnedByProject })

    expect((await $.classic.PreModelSwitch(ask('command', FABLE, 'fable'))).permissionDecision).toBeUndefined()
    expect((await $.classic.PreModelSwitch(ask('command', FABLE, null))).permissionDecision).toBeUndefined()
    expect((await $.classic.PreModelSwitch(ask('sdk', FABLE, 'fable'))).permissionDecision).toBeUndefined()
  })

  test('on: a switch from the desktop app or Remote Control (sdk) is the person\'s and asks too', { options: { lock: true } }, async ($, on) => {
    world(on, { settings: pinnedByProject })

    const ran = await $.classic.PreModelSwitch(ask('sdk'))
    expect(ran.permissionDecision).toBe('ask')
    expect(ran.permissionDecisionReason).toBe(`project pins ${FABLE}`)
  })

  test('on: the ask replaces an allow from a hook beneath, failing safe', { options: { lock: true } }, async ($, on) => {
    world(on, { settings: pinnedByProject, beneathPre: { permissionDecision: 'allow' } })

    expect((await $.classic.PreModelSwitch(ask())).permissionDecision).toBe('ask')
  })

  test('on: a deny from a hook beneath stands', { options: { lock: true } }, async ($, on) => {
    world(on, { settings: pinnedByProject, beneathPre: { permissionDecision: 'deny' } })

    expect((await $.classic.PreModelSwitch(ask())).permissionDecision).toBe('deny')
  })

  test('on: a subagent\'s switch is never asked about', { options: { lock: true } }, async ($, on) => {
    world(on, { settings: pinnedByProject })

    expect((await $.classic.PreModelSwitch({ ...ask(), agent_id: 'sub-1' })).permissionDecision).toBeUndefined()
  })

  test('on: with no pin nothing is asked', { options: { lock: true } }, async ($, on) => {
    world(on)

    expect((await $.classic.PreModelSwitch(ask('picker'))).permissionDecision).toBeUndefined()
  })

  test('on: an unreadable settings file fails open instead of blocking the switch', { options: { lock: true } }, async ($, on) => {
    world(on, { isSettingsBroken: true })

    const ran = await $.classic.PreModelSwitch(ask())
    expect(ran.permissionDecision).toBeUndefined()
  })
})

describe('fail-safe', () => {
  test('unreadable settings pin nothing and never break a model switch', async ($, on) => {
    const seen = world(on, { isSettingsBroken: true, model: SONNET })

    await $.classic.PostModelSwitch(switched(SONNET, 'resume'))
    await $.classic.SessionStart({ source: 'startup' })
    expect(seen.statuses).toHaveLength(0)
    expect(seen.switches).toHaveLength(0)
  })

  test('a model that cannot be read leaves the session start alone', async ($, on) => {
    world(on, { settings: pinnedByProject, isModelUnreadable: true })

    const started = await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(started.cwd).toBe('/repo')
  })
})

describe('/model-pin', () => {
  // Typed as the person's Enter in the composer would raise it.
  const run = ($: Engine, args: string, origin: Parameters<Engine['command']['run']>[0]['origin'] = { kind: 'composer' }) =>
    $.command.run({
      command: 'model-pin',
      args,
      origin,
      presentation: { isFullscreen: false, columns: 80 },
    })

  test('setting a pin stores it for this project root and offers the switch, never runs it', async ($, on) => {
    const seen = world(on, { model: SONNET, settings: { user: { model: SONNET } } })

    const set = await run($, FABLE)
    expect(set.text).toContain(`Pinned this project to ${FABLE}`)
    expect(set.text).toContain('Press Enter on the /model line')
    await seen.clock.settle()
    expect(seen.switches).toEqual([])
    expect(seen.fills).toEqual([`/model ${FABLE}`])

    // The store holds the pin under this root only.
    expect(seen.store['pin:/repo']).toBe(FABLE)
  })

  test('with a draft in the composer, setting a pin names the command instead of filling', async ($, on) => {
    const seen = world(on, { model: SONNET, draft: 'half a thought' })

    const set = await run($, FABLE)
    expect(set.text).toContain(`Type /model ${FABLE} to switch`)
    await seen.clock.settle()
    expect(seen.switches).toEqual([])
    expect(seen.fills).toEqual([])
  })

  test('a pin that already is the person\'s default queues /model, and the reply never claims the switch', async ($, on) => {
    const seen = world(on, { model: SONNET, settings: { user: { model: FABLE } } })

    const set = await run($, FABLE)
    expect(set.text).toContain('/model is queued to switch the session')
    expect(set.text).toContain('offered at the prompt instead')
    expect(set.text).not.toContain('Switching the session now')
    await seen.clock.settle()
    // The kit refuses a /model queued inside this hook: the reply above still
    // holds, and the offer that follows says what happened.
    expect(seen.switches).toEqual([])
    expect(seen.fills).toEqual([`/model ${FABLE}`])
    expect(seen.toasts).toEqual([`Press Enter to return to ${FABLE}.`])
  })

  test('with the session model not known yet, /model-pin answers instead of failing', async ($, on) => {
    world(on, { settings: pinnedByProject, isModelUnreadable: true })

    const shown = await run($, '')
    expect(shown.text).toContain(`Pinned to ${FABLE} (project)`)
    expect(shown.text).toContain('not known yet')
  })

  test('with the session model not known yet, setting a pin saves it and says how to switch', async ($, on) => {
    const seen = world(on, { isModelUnreadable: true })

    const set = await run($, FABLE)
    expect(set.text).toContain(`Pinned this project to ${FABLE}`)
    expect(seen.store['pin:/repo']).toBe(FABLE)
    expect(seen.switches).toEqual([])
  })

  test('the override beats settings, shows itself, and clearing falls back to settings', async ($, on) => {
    const seen = world(on, { model: FABLE, settings: { project: { model: SONNET } }, store: { 'pin:/repo': FABLE } })

    expect((await run($, '')).text).toContain(`Pinned to ${FABLE} (override)`)

    const cleared = await run($, 'clear')
    expect(cleared.text).toContain(`still pinned to ${SONNET} by its project settings`)
    expect(seen.store['pin:/repo']).toBeUndefined()
  })

  test('a malformed model id is refused and nothing is stored', async ($, on) => {
    const seen = world(on)

    const refused = await run($, 'opus && reboot')
    expect(refused.text).toContain('one model id or alias')
    expect(seen.store['pin:/repo']).toBeUndefined()
    expect(seen.switches).toHaveLength(0)
  })

  test('an alias override is swapped for the resolved id the switch lands on', async ($, on) => {
    const seen = world(on, { model: SONNET })

    await run($, 'fable')
    expect(seen.store['pin:/repo']).toBe('fable')

    await $.classic.PostModelSwitch(switched(FABLE, 'command', 'fable'))
    expect(seen.store['pin:/repo']).toBe(FABLE)
  })

  test('an alias swap never undoes a clear or a new pin another session wrote meanwhile', async ($, on) => {
    // Read 1 is this hook's own pin lookup; the other session writes right after it.
    const cleared = world(on, { model: SONNET, store: { 'pin:/repo': 'fable' }, otherSession: { afterReads: 1 } })

    await $.classic.PostModelSwitch(switched(FABLE, 'command', 'fable'))
    expect(cleared.store['pin:/repo']).toBeUndefined()
  })

  test('an alias swap keeps a different pin another session set meanwhile', async ($, on) => {
    const repinned = world(on, { model: SONNET, store: { 'pin:/repo': 'fable' }, otherSession: { afterReads: 1, value: SONNET } })

    await $.classic.PostModelSwitch(switched(FABLE, 'command', 'fable'))
    expect(repinned.store['pin:/repo']).toBe(SONNET)
  })

  test('a one-off switch to another version of an alias pin never re-pins the project', async ($, on) => {
    const seen = world(on, { model: 'claude-opus-5-5', store: { 'pin:/repo': 'opus' } })

    await $.classic.PostModelSwitch(switched('claude-opus-4-1', 'command', 'claude-opus-4-1'))
    expect(seen.store['pin:/repo']).toBe('opus')
  })

  test('only the person can set or clear the pin; anyone may read it', { options: { lock: true } }, async ($, on) => {
    const seen = world(on, { settings: pinnedByProject, model: FABLE, store: { 'pin:/repo': FABLE } })

    const peer = await run($, SONNET, { kind: 'peer' } as never)
    expect(peer.text).toContain('Only you can change the model pin')
    const channel = await run($, 'clear', { kind: 'channel', server: 'slack' } as never)
    expect(channel.text).toContain('Only you can change the model pin')
    const plugin = await run($, SONNET, { kind: 'plugin', name: 'other' } as never)
    expect(plugin.text).toContain('Only you can change the model pin')
    await seen.clock.settle()

    expect(seen.store['pin:/repo']).toBe(FABLE)
    expect(attempts(seen)).toBe(0)
    // The lock still guards the pin the refused command tried to move.
    expect((await $.classic.PreModelSwitch(switched(SONNET, 'command', 'sonnet'))).permissionDecision).toBe('ask')

    expect((await run($, '', { kind: 'peer' } as never)).text).toContain(`Pinned to ${FABLE} (override)`)
  })

  test('every origin that is not the person is refused, and nothing moves', async ($, on) => {
    const seen = world(on, { settings: pinnedByProject, model: SONNET, store: { 'pin:/repo': FABLE } })
    const others = [
      'peer',
      'peer-send-message',
      'task-notification',
      'scheduled-trigger',
      'channel',
      'coordinator',
      'observer',
      'observer-activity',
      'projects-relay',
      'auto-continuation',
      'unclassified',
      'slack-ping',
      'plugin',
    ]

    for (const kind of others) {
      expect((await run($, SONNET, { kind } as never)).text).toContain('Only you can change the model pin')
      expect((await run($, 'clear', { kind } as never)).text).toContain('Only you can change the model pin')
    }
    await seen.clock.settle()

    expect(seen.store['pin:/repo']).toBe(FABLE)
    expect(attempts(seen)).toBe(0)
  })

  test('the person can set and clear the pin from the desktop app, which runs over the SDK', async ($, on) => {
    const seen = world(on, { model: SONNET })

    expect((await run($, FABLE, { kind: 'sdk' })).text).toContain(`Pinned this project to ${FABLE}`)
    expect(seen.store['pin:/repo']).toBe(FABLE)
    await seen.clock.settle()
    expect(seen.fills).toEqual([`/model ${FABLE}`])

    expect((await run($, 'clear', { kind: 'sdk' })).text).toContain('Model pin cleared for this project.')
    expect(seen.store['pin:/repo']).toBeUndefined()
  })

  test('the person can also set the pin through Remote Control', async ($, on) => {
    const seen = world(on, { model: SONNET })

    expect((await run($, FABLE, { kind: 'bridge' })).text).toContain(`Pinned this project to ${FABLE}`)
    expect(seen.store['pin:/repo']).toBe(FABLE)
  })

  test('the override is keyed by the main working tree, so linked worktrees share it', async ($, on) => {
    const seen = world(on, { model: FABLE, repoRoot: '/main' })

    await run($, FABLE)
    expect(seen.store['pin:/main']).toBe(FABLE)
    expect(seen.store['pin:/repo']).toBeUndefined()
  })

  test('an override shadowed by local settings is saved but says so and switches nothing', async ($, on) => {
    const seen = world(on, { model: SONNET, settings: { local: { model: SONNET } } })

    const set = await run($, FABLE)
    expect(set.text).toContain(`its local settings pin ${SONNET}`)
    await seen.clock.settle()
    expect(seen.store['pin:/repo']).toBe(FABLE)
    expect(attempts(seen)).toBe(0)
  })
})
