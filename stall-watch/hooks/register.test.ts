import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelApiError, On, PromptOrigin } from 'claude-code'

import { MAX_WAIT_MS, exhaustedWindow, promptExcerpt, redact, statusText, waitMs, windowText } from './format'

// 2026-10-09 18:00:00Z, which is 11:00am at the -0700 offset `date` reports below.
const T0 = Date.UTC(2026, 9, 9, 18, 0, 0)
const HOUR = 3_600_000
const CONTINUE = /transient API error; continue from where you left off/
const RESUME = /usage limit has reset; continue/

type NoteEntry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }
type Opts = {
  dropPluginSubmits?: boolean
  denyProcess?: boolean
  store?: Record<string, unknown>
  notes?: NoteEntry[]
}

/**
 * The engine beneath the plugin: every call it makes on `$` is answered here
 * and recorded, so a test reads what the plugin did.
 */
function harness(on: On, opts: Opts = {}) {
  const clock = mock.clock(on, { now: T0 })
  // The plugin's store, kept here (as the engine keeps it, by JSON value) so a test can read it.
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  // The next `storeSetFailures` writes are refused.
  const faults = { storeSetFailures: 0 }
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    if (faults.storeSetFailures > 0) {
      faults.storeSetFailures -= 1
      return { deny: 'store unavailable' }
    }
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  mock.env(on, { HOME: '/home/tester' })
  const seen = {
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    submits: [] as { text: string; origin: unknown }[],
    suggests: [] as string[],
    writes: [] as { path: string; text: string }[],
    commands: [] as string[],
    removed: [] as string[],
  }
  // The live session id: a test switches it to stand for /clear or /resume,
  // or has the next `failures` reads of it refused.
  const session = { id: 'sess-1', failures: 0 }
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') {
      seen.submits.push({ text: e.text, origin: e.origin })
      if (opts.dropPluginSubmits === true) return { drop: 'blocked by a guard' }
    }
    return { text: e.text, origin: e.origin }
  })
  on('prompt.suggest', ($, e) => {
    seen.suggests.push(e.text)
    return { isShown: true }
  })
  on('session.id', () => {
    if (session.failures > 0) {
      session.failures -= 1
      return { deny: 'session id unavailable' }
    }
    return { value: session.id }
  })
  on('session.cwd', () => ({ value: '/repo/wt' }))
  on('process.run', ($, e) => {
    if (opts.denyProcess === true) return { deny: 'no processes in this test' }
    if (e.argv[0] === '/bin/rm') seen.removed.push(String(e.argv.at(-1)))
    const stdout = e.argv[0] === 'date' ? '-0700\n' : 'feature/x\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.list', ($, e) => {
    if (e.path !== '/home/tester/.claude/stall-watch' || opts.notes === undefined) return { deny: 'no such folder' }
    return { value: opts.notes }
  })
  on('fs.write', ($, e) => {
    seen.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('command.register', ($, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.StopFailure', () => ({}))
  return { clock, seen, session, store, faults }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/repo/wt', surface: 'terminal', isInteractive: true })
}

async function typed($: Engine, text = 'build the thing') {
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
}

let turnN = 0
/**
 * A main-loop turn that dies on `error`. It starts here (turn.start) unless
 * `turnId` names a turn the test already started.
 */
async function failTurn($: Engine, error: ModelApiError, opts: { details?: string; turnId?: string } = {}) {
  turnN += 1
  const turnId = opts.turnId ?? `t${turnN}`
  if (opts.turnId === undefined) await $.turn.start({ text: '', turnId })
  await $.classic.StopFailure(opts.details === undefined ? { error } : { error, error_details: opts.details })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId, reason: 'error' })
}

/** A main-loop turn that some other origin starts and that answers. */
async function otherTurn($: Engine, origin: PromptOrigin, answer = 'ok') {
  turnN += 1
  const turnId = `o${turnN}`
  await $.prompt.submit({ text: 'from elsewhere', origin, wait: false })
  await $.turn.start({ text: 'from elsewhere', turnId })
  await $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId, reason: 'answer' })
}

async function command($: Engine, args: string, origin: PromptOrigin = { kind: 'composer' }): Promise<string> {
  const out = await $.command.run({
    command: 'stall-watch',
    args,
    origin,
    presentation: { isFullscreen: false, columns: 100 },
  })
  return String(out.text ?? '')
}

describe('auto-retry', () => {
  test('a transient failure is retried with backoff and stops at 3 per prompt', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    await typed($)
    const backoff = [30, 120, 480]
    for (let i = 0; i < 3; i += 1) {
      await failTurn($, 'overloaded')
      expect(seen.toasts.at(-1)).toBe(`stall-watch: auto-retry ${i + 1}/3 in ${backoff[i]}s`)
      expect(seen.submits.length).toBe(i)
      await clock.advance(backoff[i]! * 1000 - 1)
      expect(seen.submits.length, 'not before the backoff elapses').toBe(i)
      await clock.advance(1)
      expect(seen.submits.length).toBe(i + 1)
    }
    const last = seen.submits.at(-1)!
    expect(last.text).toMatch(CONTINUE)
    // Framed as the plugin's, never as the person's own words.
    expect(last.origin).toEqual({ kind: 'plugin', name: 'stall-watch' })

    await failTurn($, 'overloaded')
    expect(seen.toasts.at(-1)).toBe('stall-watch: auto-retry stopped after 3/3')
    await clock.advance(60 * 60_000)
    expect(seen.submits.length, 'the cap holds').toBe(3)

    // Only the person's own prompt resets the cap.
    await typed($, 'try again')
    await failTurn($, 'server_error')
    expect(seen.toasts.at(-1)).toBe('stall-watch: auto-retry 1/3 in 30s')
  })

  test('every transient kind is retried, StopFailure arriving before or after turn.complete', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    for (const kind of ['rate_limit', 'overloaded', 'server_error', 'unknown'] as const) {
      await typed($)
      await failTurn($, kind)
      await clock.advance(30_000)
    }
    expect(seen.submits.length).toBe(4)
    // Reverse order: the turn ends first, then the failure kind lands.
    await typed($)
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 'rev', reason: 'error' })
    expect(seen.toasts.filter(t => t.includes('1/3')).length).toBe(4)
    await $.classic.StopFailure({ error: 'overloaded' })
    expect(seen.toasts.at(-1)).toBe('stall-watch: auto-retry 1/3 in 30s')
    await clock.advance(30_000)
    expect(seen.submits.length).toBe(5)
  })

  test('permanent failures, context overflow, subagent turns and empty answers are never retried', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    for (const kind of ['billing_error', 'authentication_failed', 'invalid_request', 'max_output_tokens', 'model_not_found'] as const) {
      await typed($)
      await failTurn($, kind)
    }
    await typed($)
    await failTurn($, 'unknown', { details: 'prompt is too long: 212000 tokens > 200000 maximum' })
    // A subagent's failure must not resubmit into the main loop.
    await $.classic.StopFailure({ error: 'overloaded', agent_id: 'sub-1' })
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 'sub', reason: 'error', agentId: 'sub-1' })
    // A thinking-only turn answers '' and is not a failure.
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 'empty', reason: 'answer' })
    // A StopFailure with no error turn to pair with does nothing on its own.
    await $.classic.StopFailure({ error: 'overloaded' })
    await clock.advance(2 * HOUR)
    expect(seen.submits).toEqual([])
    expect(seen.toasts.filter(t => t.includes('auto-retry'))).toEqual([])
  })

  test('fail-safe: a dropped resubmit is not an attempt and is not re-armed; typing cancels a pending retry', async ($, on) => {
    const { clock, seen } = harness(on, { dropPluginSubmits: true })
    await start($)
    await typed($)
    await failTurn($, 'overloaded')
    await clock.advance(30_000)
    expect(seen.submits.length).toBe(1)
    expect(seen.toasts.at(-1)).toBe('stall-watch: auto-retry was not sent (refused)')
    expect(await command($, 'status')).toContain('Automated continues used: 0/3.')
    await clock.advance(2 * HOUR)
    expect(seen.submits.length, 'a refusing guard cannot become a loop').toBe(1)

    await failTurn($, 'overloaded')
    expect(seen.toasts.at(-1)).toBe('stall-watch: auto-retry 1/3 in 30s')
    await typed($, 'never mind, do this instead')
    await clock.advance(2 * HOUR)
    expect(seen.submits.length, 'the person took over').toBe(1)
  })
})

describe('task notifications', () => {
  test('a task-notification turn that answers gets a resume hint, never a submit', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    await $.prompt.submit({ text: 'task 7 finished', origin: { kind: 'task-notification' }, wait: false })
    await $.turn.complete({ answer: 'noted', durationMs: 5, isAborted: false, turnId: 'tn', reason: 'answer' })
    await clock.advance(2_000)
    expect(seen.suggests).toEqual(['resume'])
    expect(seen.submits).toEqual([])

    // The person's own turn gets no hint.
    await typed($)
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 'own', reason: 'answer' })
    await clock.advance(2_000)
    expect(seen.suggests).toEqual(['resume'])
  })
})

describe('limit countdown', () => {
  test('pins the countdown at 85%+, refreshes each minute, writes the note at 90%, clears below', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    await typed($, 'ship it, token=abc123secret')
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 92.4, resetsAt: new Date(T0 + 2 * HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: 88 },
        { kind: 'spend_limit', percentUsed: 40, resetsAt: new Date(T0 + HOUR).toISOString() },
      ],
      changed: ['rateLimits'],
    } as never)
    expect(seen.statuses.at(-1)).toBe('5h 92% · resets 1:00pm (in 2h 0m)  |  weekly 88%')
    await clock.advance(60_000)
    expect(seen.statuses.at(-1)).toBe('5h 92% · resets 1:00pm (in 1h 59m)  |  weekly 88%')

    expect(seen.writes.length).toBe(1)
    const note = seen.writes[0]!
    expect(note.path).toBe('/home/tester/.claude/stall-watch/sess-1.md')
    expect(note.text).toContain('- branch: feature/x')
    expect(note.text).toContain('- written: 2026-10-09 11:00am (local)')
    expect(note.text).toContain('- limit: 5h 92% · resets 1:00pm (in 2h 0m)')
    expect(note.text).toContain('ship it, token=[redacted]')
    expect(note.text).not.toContain('abc123secret')

    // Empty readings are no news: nothing changes.
    const before = seen.statuses.length
    await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] } as never)
    expect(seen.statuses.length).toBe(before)

    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: new Date(T0 + 5 * HOUR).toISOString() }],
      changed: ['rateLimits'],
    } as never)
    expect(seen.statuses.at(-1)).toBeUndefined()
    const cleared = seen.statuses.length
    await clock.advance(5 * 60_000)
    expect(seen.statuses.length, 'the ticker stops once cleared').toBe(cleared)
    expect(seen.writes.length, 'one note per window').toBe(1)
  })

  test('fail-safe: with no local offset and bad readings the line degrades, never NaN', async ($, on) => {
    const { seen } = harness(on, { denyProcess: true })
    await start($)
    expect(seen.commands).toEqual(['stall-watch'])
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'seven_day', percentUsed: 97, resetsAt: new Date(T0 + 26 * HOUR).toISOString() },
        { kind: 'five_hour', percentUsed: 99, resetsAt: 'not a date' },
        { kind: 'five_hour', percentUsed: Number.NaN },
      ],
      changed: ['rateLimits'],
    } as never)
    const line = seen.statuses.at(-1) ?? ''
    expect(line).toBe('5h 99%  |  weekly 97% · resets in 1d 2h')
    expect(line).not.toContain('NaN')
    // git was refused too: the note still lands, branch unknown.
    expect(seen.writes[0]?.text).toContain('- branch: unknown')
  })

  test('formatting helpers', () => {
    const now = T0
    expect(windowText({ kind: 'seven_day', percentUsed: 92 }, now, -420)).toBe('weekly 92%')
    expect(windowText({ kind: 'seven_day', percentUsed: 92, resetsAt: new Date(T0 + 12 * HOUR).toISOString() }, now, -420))
      .toBe('weekly 92% · resets 11:00pm (in 12h 0m)')
    expect(windowText({ kind: 'seven_day', percentUsed: 92, resetsAt: new Date(T0 + 36 * HOUR).toISOString() }, now, -420))
      .toBe('weekly 92% · resets Sat 11:00pm (in 1d 12h)')
    expect(windowText({ kind: 'spend_limit', percentUsed: 104.5 }, now, 330)).toBe('spend 104%')
    expect(statusText([], now, -420)).toBeUndefined()
    expect(statusText([{ kind: 'five_hour', percentUsed: 99, resetsAt: new Date(T0 - 1).toISOString() }], now, -420))
      .toBeUndefined()
    expect(exhaustedWindow([{ kind: 'five_hour', percentUsed: 80 }], now)).toBeUndefined()
  })
})

describe('/stall-watch resume after reset', () => {
  test('off by default; on arms a resume at reset+30s for a rate_limit on an exhausted window', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    expect(await command($, 'status')).toContain('resume after reset is OFF')
    await typed($)
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(T0 + HOUR).toISOString() }],
      changed: ['rateLimits'],
    } as never)
    await failTurn($, 'rate_limit')
    // Exhausted window: no seconds-scale retry, and OFF means no resume either.
    expect(seen.toasts.at(-1)).toBe('stall-watch: usage limit reached; /stall-watch on resumes after the reset')
    await clock.advance(10 * 60_000)
    expect(seen.submits).toEqual([])

    expect(await command($, 'on')).toBe('stall-watch: resume after reset is ON; armed for the current limit.')
    expect(await command($, 'status')).toContain('Resume armed for 12:00pm.')
    await clock.advance(HOUR + 30_000 - 10 * 60_000 - 1)
    expect(seen.submits).toEqual([])
    await clock.advance(1)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]!.text).toMatch(RESUME)
  })

  test('the arm persists per session, re-arms on session.start, and off or typing disarms it', async ($, on) => {
    const resetsAt = new Date(T0 + HOUR).toISOString()
    const { clock, seen } = harness(on, {
      store: { 'session:sess-1': { sessionId: 'sess-1', enabled: true, resetsAt, armedAt: T0 - HOUR, updatedAt: T0 - HOUR } },
    })
    await start($)
    expect(await command($, 'status')).toContain('resume after reset is ON')
    expect(await command($, 'status')).toContain('Resume armed for 12:00pm.')
    expect(await command($, 'off')).toBe('stall-watch: resume after reset is OFF for this session.')
    await clock.advance(2 * HOUR)
    expect(seen.submits).toEqual([])

    expect(await command($, 'on')).toBe('stall-watch: resume after reset is ON for this session.')
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 100, resetsAt: new Date(T0 + 30 * HOUR).toISOString() }],
      changed: ['rateLimits'],
    } as never)
    await typed($)
    await failTurn($, 'rate_limit')
    expect(seen.toasts.at(-1)).toMatch(/^stall-watch: will resume at /)
    await typed($, 'I am back early')
    await clock.advance(40 * HOUR)
    expect(seen.submits, 'a composer prompt disarms the resume').toEqual([])
    expect(await command($, 'bogus')).toBe('Usage: /stall-watch on | off | status')
  })
})

function limits(...rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]) {
  return { context: { window: 200_000 }, rateLimits, changed: ['rateLimits'] } as never
}

describe('session switches', () => {
  test('a /resume to another conversation cancels a pending retry and an armed resume, and turns resume off', async ($, on) => {
    const { clock, seen, session } = harness(on)
    await start($)
    await typed($)
    await failTurn($, 'overloaded')
    await $.session.end({ reason: 'resume', sessionId: 'sess-1', resume: { id: 'sess-1' } } as never)
    session.id = 'sess-2'
    await clock.advance(31_000)
    expect(seen.submits, 'no retry into the conversation switched to').toEqual([])

    expect(await command($, 'on')).toBe('stall-watch: resume after reset is ON for this session.')
    await $.session.measure(limits({ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(T0 + HOUR).toISOString() }))
    await typed($)
    await failTurn($, 'rate_limit')
    expect(await command($, 'status')).toContain('Resume armed for')
    await $.session.end({ reason: 'resume', sessionId: 'sess-2', resume: { id: 'sess-2' } } as never)
    session.id = 'sess-3'
    const status = await command($, 'status')
    expect(status).toContain('resume after reset is OFF')
    expect(status).toContain('No resume armed.')
    await clock.advance(2 * HOUR)
    expect(seen.submits).toEqual([])
  })

  test('fail-safe: a session id change with no session.end still keeps an armed retry from firing', async ($, on) => {
    const { clock, seen, session } = harness(on)
    await start($)
    await typed($)
    await failTurn($, 'overloaded')
    session.id = 'sess-9'
    await clock.advance(31_000)
    expect(seen.submits).toEqual([])
    expect(await command($, 'status')).toContain('No retry pending.')
  })
})

describe('rate_limit decisions', () => {
  test('resume waits for the full window, not a nearly-full one with a later reset', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    await command($, 'on')
    await $.session.measure(
      limits(
        { kind: 'five_hour', percentUsed: 100, resetsAt: new Date(T0 + 2 * HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: 96, resetsAt: new Date(T0 + 96 * HOUR).toISOString() },
      ),
    )
    await typed($)
    await failTurn($, 'rate_limit')
    expect(seen.toasts.at(-1)).toBe('stall-watch: will resume at 1:00pm')
    await clock.advance(2 * HOUR + 31_000)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]!.text).toMatch(RESUME)
  })

  test('a rate_limit with a stale or reset-less full window falls back to the backoff retry', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    // Stale: the reading's reset has passed and no newer reading came.
    await $.session.measure(limits({ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(T0 + HOUR).toISOString() }))
    await clock.advance(2 * HOUR)
    await typed($)
    await failTurn($, 'rate_limit')
    expect(seen.toasts.at(-1)).toBe('stall-watch: auto-retry 1/3 in 30s')
    await clock.advance(30_000)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]!.text).toMatch(CONTINUE)

    // Resume on, window nearly full and no reset known: still retried.
    await command($, 'on')
    await $.session.measure(limits({ kind: 'five_hour', percentUsed: 99 }))
    await typed($)
    await failTurn($, 'rate_limit')
    expect(seen.toasts.at(-1)).toBe('stall-watch: auto-retry 1/3 in 30s')
    await clock.advance(30_000)
    expect(seen.submits.length).toBe(2)
  })

  test('retries and resumes share one cap of 3 per prompt', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    await command($, 'on')
    await typed($)
    let now = T0
    for (let i = 0; i < 6; i += 1) {
      const resetsAt = new Date(now + 10 * 60_000).toISOString()
      await $.session.measure(limits({ kind: 'five_hour', percentUsed: 100, resetsAt }))
      await failTurn($, 'rate_limit')
      await clock.advance(11 * 60_000)
      await failTurn($, 'overloaded')
      await clock.advance(10 * 60_000)
      now += 21 * 60_000
    }
    expect(seen.submits.length).toBe(3)
    expect(seen.submits.map(s => (RESUME.test(s.text) ? 'resume' : 'retry'))).toEqual(['resume', 'retry', 'resume'])
  })
})

describe('/stall-watch origins', () => {
  test('only the person (composer, bridge, sdk) can turn resume on; off and status answer anyone', async ($, on) => {
    const { seen } = harness(on)
    await start($)
    for (const origin of [
      { kind: 'plugin', name: 'other' },
      { kind: 'peer' },
      { kind: 'task-notification' },
      { kind: 'scheduled-trigger' },
      { kind: 'unclassified' },
    ] as PromptOrigin[]) {
      expect(await command($, 'on', origin), origin.kind).toBe('stall-watch: only you can turn resume on (type /stall-watch on).')
    }
    expect(await command($, 'status', { kind: 'plugin', name: 'other' } as PromptOrigin)).toContain('resume after reset is OFF')
    // The desktop app hosts its sessions over the SDK: its person turns resume on too.
    expect(await command($, 'on', { kind: 'sdk' })).toBe('stall-watch: resume after reset is ON for this session.')
    await command($, 'off')
    expect(await command($, 'on', { kind: 'bridge' })).toBe('stall-watch: resume after reset is ON for this session.')
    expect(await command($, 'off', { kind: 'plugin', name: 'other' } as PromptOrigin)).toBe(
      'stall-watch: resume after reset is OFF for this session.',
    )
    expect(seen.submits).toEqual([])
  })
})

describe('resume note hygiene', () => {
  test('redact scrubs common credential shapes', () => {
    const samples = [
      `shpat_${'a1'.repeat(16)}`,
      `AIza${'B'.repeat(35)}`,
      'Authorization: Bearer abcdefghijklmnopqrstuvwx',
      `npm_${'a'.repeat(36)}`,
      `glpat-${'a'.repeat(20)}`,
      'my password is hunter2xyz',
      'api_key: zzzzsecretvalue',
    ]
    for (const sample of samples) {
      const out = redact(`before ${sample} after`)
      expect(out).toContain('[redacted]')
      expect(out).toStartWith('before ')
      expect(out).toEndWith(' after')
    }
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuvwx')).toBe('Authorization: Bearer [redacted]')
    expect(redact('my password is hunter2xyz')).toBe('my password is [redacted]')
    expect(redact('build the checkout page')).toBe('build the checkout page')
  })

  test('redact covers env-var, URL, JSON, camelCase, flag and AWS secret shapes', () => {
    // [input, expected output, the secret that must be gone]
    const cases: [string, string, string][] = [
      ['DB_PASSWORD=hunter2hunter2', 'DB_PASSWORD=[redacted]', 'hunter2hunter2'],
      ['SHOPIFY_API_SECRET=abcdef0123456789', 'SHOPIFY_API_SECRET=[redacted]', 'abcdef0123456789'],
      ['STAY_AI_API_KEY=stay0123456789', 'STAY_AI_API_KEY=[redacted]', 'stay0123456789'],
      ['KLAVIYO_TOKEN=pk_live_abc123', 'KLAVIYO_TOKEN=[redacted]', 'pk_live_abc123'],
      ['postgres://admin:S3cr3tPass@db.example.com/prod', 'postgres://admin:[redacted]@db.example.com/prod', 'S3cr3tPass'],
      ['{"password": "hunter2hunter2"}', '{"password": "[redacted]"}', 'hunter2hunter2'],
      ['{"clientSecret":"two words","user":"bob"}', '{"clientSecret":"[redacted]","user":"bob"}', 'two words'],
      [
        'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        'aws_secret_access_key = [redacted]',
        'wJalrXUtnFEMI',
      ],
      ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'AWS_SECRET_ACCESS_KEY=[redacted]', 'wJalrXUtnFEMI'],
      ["const dbPassword = 'x1y2z3w4'", "const dbPassword = '[redacted]'", 'x1y2z3w4'],
      ['X-Api-Key: abc123def456', 'X-Api-Key: [redacted]', 'abc123def456'],
      ['mysql --password hunter2hunter2 -h db', 'mysql --password [redacted] -h db', 'hunter2hunter2'],
      ['the token is: abc123xyz', 'the token is: [redacted]', 'abc123xyz'],
      [`id ASIA${'Q'.repeat(16)} here`, 'id [redacted] here', `ASIA${'Q'.repeat(16)}`],
      // V2: env-var forms, URL userinfo, JSON keys, bare AWS secrets and the other leaked shapes.
      ['OPENAI_API_KEY=zq9xzq9x', 'OPENAI_API_KEY=[redacted]', 'zq9x'],
      ['STRIPE_SECRET=zq9xzq9x', 'STRIPE_SECRET=[redacted]', 'zq9x'],
      ['SLACK_BOT_TOKEN=zq9xzq9x', 'SLACK_BOT_TOKEN=[redacted]', 'zq9x'],
      ['DB_PASS=hunter2hunter2', 'DB_PASS=[redacted]', 'hunter2'],
      ['SMTP_PASS=hunter2hunter2', 'SMTP_PASS=[redacted]', 'hunter2'],
      ['ENCRYPTION_KEY=q1w2e3r4', 'ENCRYPTION_KEY=[redacted]', 'q1w2e3r4'],
      ['JWT_SIGNING_KEY=q1w2e3r4', 'JWT_SIGNING_KEY=[redacted]', 'q1w2e3r4'],
      ['{"pass": "hunter2hunter2"}', '{"pass": "[redacted]"}', 'hunter2'],
      ['{"token":"two words"}', '{"token":"[redacted]"}', 'two words'],
      ['redis://:S3cretPw99@cache.internal:6379', 'redis://:[redacted]@cache.internal:6379', 'S3cretPw99'],
      ['postgres://admin:pa/ss99@db/x', 'postgres://admin:[redacted]@db/x', 'pa/ss99'],
      ['postgres://admin:p@ss99@db/x', 'postgres://admin:[redacted]@db/x', 'ss99'],
      ['mysql -uroot -phunter2hunter2', 'mysql -uroot -p[redacted]', 'hunter2'],
      ['login with password hunter2hunter2', 'login with password [redacted]', 'hunter2'],
      ['DB_PASSWORD is xyz', 'DB_PASSWORD is [redacted]', 'xyz'],
      ['--db-pass hunter', '--db-pass [redacted]', 'hunter'],
      ['use wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY for s3', 'use [redacted] for s3', 'K7MDENG'],
      ['keys AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'keys [redacted] [redacted]', 'K7MDENG'],
      ['https://hooks.slack.com/services/T0000/B0000/XXXXXXXX', 'https://hooks.slack.com/services/[redacted]', 'B0000'],
      [`whsec_${'a1B2'.repeat(8)}`, '[redacted]', 'a1B2'],
      // A commit hash looks as random as a key: over-redacted, which a resume note can live with.
      ['revert 3f2a9c0d1e2b3a4f5c6d7e8f9a0b1c2d3e4f5a6b please', 'revert [redacted] please', '3f2a9c0d'],
    ]
    for (const [input, expected, secret] of cases) {
      const out = redact(`before ${input} after`)
      expect(out, input).toBe(`before ${expected} after`)
      expect(out, input).not.toContain(secret)
    }
    // A cookie header is cut to the end of its line.
    expect(redact('Cookie: sessionid=abc123; csrftoken=def')).toBe('Cookie: [redacted]')
    // Ordinary text is left alone: no keyword, a word next to one, a path, a URL without a password.
    for (const plain of [
      'token isolation matters',
      'fix the password reset page on mods/stall-watch/hooks/register.tsx line 42',
      'bypass the passenger cache for the monkey test',
      'see https://example.com/a@b please',
    ]) {
      expect(redact(plain)).toBe(plain)
    }
  })

  test('redact stays linear on long pasted blobs', () => {
    const started = Date.now()
    for (const blob of [
      'x'.repeat(200_000),
      'a.'.repeat(100_000),
      'ab_'.repeat(70_000),
      'a://b:'.repeat(30_000),
      'https://:'.repeat(30_000),
      'mysql -u '.repeat(30_000),
      'password reset '.repeat(15_000),
      'DB_PASS:'.repeat(30_000),
      'aB3/'.repeat(50_000),
    ]) redact(blob)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('the note keeps only a redacted 80-character excerpt of the prompt', () => {
    expect(promptExcerpt('fix the  checkout\n\nbutton')).toBe('fix the checkout button')
    const long = `${'a'.repeat(70)} DB_PASSWORD=hunter2hunter2 and then ${'b'.repeat(50)} sk-${'Z'.repeat(30)}`
    const excerpt = promptExcerpt(long)
    expect(excerpt.length).toBe(83)
    expect(excerpt).toEndWith('...')
    expect(excerpt).not.toContain('hunter2')
    expect(excerpt).not.toContain('ZZZZ')
    // Redacted before it is cut: a PEM key starting inside the excerpt never leaks a prefix of its body.
    const pem = `key: -----BEGIN RSA PRIVATE KEY-----\n${'M'.repeat(3_000)}\n-----END RSA PRIVATE KEY----- done`
    expect(promptExcerpt(pem)).toBe('key: [redacted] done')
  })

  test('session.start deletes only its own notes older than a week', async ($, on) => {
    const day = 24 * HOUR
    const { seen } = harness(on, {
      notes: [
        { name: 'old-session.md', kind: 'file', size: 10, mtimeMs: T0 - 8 * day, isLink: false },
        { name: 'fresh-session.md', kind: 'file', size: 10, mtimeMs: T0 - day, isLink: false },
        { name: 'linked.md', kind: 'other', size: 10, mtimeMs: 0, isLink: true },
        { name: 'keep.txt', kind: 'file', size: 10, mtimeMs: T0 - 30 * day, isLink: false },
        { name: '..md', kind: 'file', size: 10, mtimeMs: T0 - 30 * day, isLink: false },
        { name: 'sub', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      ],
    })
    await start($)
    expect(seen.removed).toEqual(['/home/tester/.claude/stall-watch/old-session.md'])
  })
})

describe('the session moved on (V1)', () => {
  for (const origin of [
    { kind: 'task-notification' },
    { kind: 'peer' },
    { kind: 'sdk' },
    { kind: 'scheduled-trigger' },
    { kind: 'slack-ping' },
    { kind: 'unclassified' },
  ] as PromptOrigin[]) {
    test(`a pending retry is dropped once a ${origin.kind} turn runs`, async ($, on) => {
      const { clock, seen } = harness(on)
      await start($)
      await typed($)
      await failTurn($, 'overloaded')
      expect(seen.toasts.at(-1)).toBe('stall-watch: auto-retry 1/3 in 30s')
      await clock.advance(10_000)
      await otherTurn($, origin)
      await clock.advance(2 * HOUR)
      expect(seen.submits, 'no continue after a turn that answered').toEqual([])
      expect(await command($, 'status')).toContain('No retry pending.')
    })
  }

  test('the third retry does not fire after a peer turn answered during its 8-minute wait', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    await typed($)
    await failTurn($, 'overloaded')
    await clock.advance(30_000)
    await failTurn($, 'overloaded')
    await clock.advance(120_000)
    expect(seen.submits.length).toBe(2)
    await failTurn($, 'overloaded')
    expect(seen.toasts.at(-1)).toBe('stall-watch: auto-retry 3/3 in 480s')
    await clock.advance(60_000)
    await otherTurn($, { kind: 'peer' })
    await clock.advance(HOUR)
    expect(seen.submits.length).toBe(2)
  })

  test('a turn starting is enough (the engine’s own continuation), and an ending without error covers a missed start', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    await typed($)
    await failTurn($, 'overloaded')
    await $.turn.start({ text: '', turnId: 'engine-continue' })
    await clock.advance(31_000)
    expect(seen.submits).toEqual([])

    await failTurn($, 'overloaded')
    expect(seen.toasts.at(-1)).toBe('stall-watch: auto-retry 1/3 in 30s')
    // No turn.start reached the plugin; the interrupted turn's end still counts.
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 'esc', reason: 'aborted' })
    await clock.advance(31_000)
    expect(seen.submits).toEqual([])
  })

  test('the plugin’s own retry turn does not cancel the next retry', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    await typed($)
    await failTurn($, 'overloaded')
    await clock.advance(30_000)
    expect(seen.submits.length).toBe(1)
    // The continue runs as its own turn (failTurn starts it) and fails again.
    await failTurn($, 'overloaded')
    await clock.advance(120_000)
    expect(seen.submits.length).toBe(2)
  })

  test('a failed turn the person typed over is not retried: their queued prompt runs next', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    await typed($)
    await $.turn.start({ text: 'build the thing', turnId: 'q1' })
    await $.prompt.submit({ text: 'also add tests', origin: { kind: 'composer' }, turnId: 'q1', wait: false })
    await failTurn($, 'overloaded', { turnId: 'q1' })
    expect(seen.toasts.filter(t => t.includes('auto-retry'))).toEqual([])
    await $.turn.start({ text: 'also add tests', turnId: 'q2' })
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 'q2', reason: 'answer' })
    await clock.advance(31_000)
    expect(seen.submits).toEqual([])

    // Typed over through the bridge, the failure's kind landing after the turn ended,
    // and the prompt went into that turn (no turn of its own): still no retry.
    await $.turn.start({ text: 'next', turnId: 'q3' })
    await $.prompt.submit({ text: 'from my phone', origin: { kind: 'bridge' }, turnId: 'q3', wait: false })
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 'q3', reason: 'error' })
    await $.classic.StopFailure({ error: 'overloaded' })
    await clock.advance(31_000)
    expect(seen.submits).toEqual([])

    // A later failure nobody typed over is retried as usual.
    await failTurn($, 'overloaded')
    expect(seen.toasts.at(-1)).toBe('stall-watch: auto-retry 1/3 in 30s')
    await clock.advance(30_000)
    expect(seen.submits.length).toBe(1)
  })

  test('an armed resume is dropped once another turn answers', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    await command($, 'on')
    await $.session.measure(limits({ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(T0 + HOUR).toISOString() }))
    await typed($)
    await failTurn($, 'rate_limit')
    expect(seen.toasts.at(-1)).toBe('stall-watch: will resume at 12:00pm')
    await otherTurn($, { kind: 'task-notification' })
    expect(await command($, 'status')).toContain('No resume armed.')
    await clock.advance(2 * HOUR)
    expect(seen.submits).toEqual([])
  })
})

describe('reload (V3)', () => {
  test('a session.start fired again (reload, respawn) re-arms a retry whose timer is gone', async ($, on) => {
    const { clock, seen, session } = harness(on)
    await start($)
    await typed($)
    await failTurn($, 'overloaded')
    // The timer fires but its run fails: the plan stays in $.state with no
    // timer behind it, which is what a hot reload leaves.
    // (No other event in between: any hook would re-arm it lazily.)
    session.failures = 1
    await clock.advance(30_000)
    expect(seen.submits).toEqual([])
    await clock.advance(HOUR)
    expect(seen.submits, 'no timer behind it').toEqual([])

    // The session.start a reload fires re-arms it at once, with no other event.
    await start($)
    await clock.advance(1)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]!.text).toMatch(CONTINUE)
    // Fired once: a further session.start arms nothing more.
    await start($)
    await clock.advance(HOUR)
    expect(seen.submits.length).toBe(1)
  })
})

describe('nearly-full windows (V4)', () => {
  test('a rate_limit at 99.9 % waits for the reset and spends no retry', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    await $.session.measure(limits({ kind: 'five_hour', percentUsed: 99.9, resetsAt: new Date(T0 + 3 * HOUR).toISOString() }))
    await typed($)
    await failTurn($, 'rate_limit')
    expect(seen.toasts.at(-1)).toBe('stall-watch: usage limit reached; /stall-watch on resumes after the reset')

    await command($, 'on')
    for (let i = 0; i < 4; i += 1) await failTurn($, 'rate_limit')
    expect(seen.toasts.at(-1)).toBe('stall-watch: will resume at 2:00pm')
    expect(await command($, 'status')).toContain('Automated continues used: 0/3.')
    await clock.advance(3 * HOUR + 30_000)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]!.text).toMatch(RESUME)
  })

  test('exhaustedWindow: 95 % counts, a full window outranks a fuller-reading nearly-full one', () => {
    const at = (h: number) => new Date(T0 + h * HOUR).toISOString()
    expect(exhaustedWindow([{ kind: 'five_hour', percentUsed: 94.9, resetsAt: at(2) }], T0)).toBeUndefined()
    expect(exhaustedWindow([{ kind: 'five_hour', percentUsed: 95, resetsAt: at(2) }], T0)?.kind).toBe('five_hour')
    expect(exhaustedWindow([{ kind: 'five_hour', percentUsed: 99.9 }], T0)).toBeUndefined()
    expect(
      exhaustedWindow(
        [
          { kind: 'seven_day', percentUsed: 99, resetsAt: at(96) },
          { kind: 'five_hour', percentUsed: 100, resetsAt: at(2) },
        ],
        T0,
      )?.kind,
    ).toBe('five_hour')
    expect(
      exhaustedWindow(
        [
          { kind: 'seven_day', percentUsed: 96, resetsAt: at(96) },
          { kind: 'five_hour', percentUsed: 98, resetsAt: at(2) },
        ],
        T0,
      )?.kind,
    ).toBe('five_hour')
  })
})

/** Spends the cap: three overloaded failures, each retried after its full backoff. */
async function exhaustCap($: Engine, clock: { advance: (ms: number) => Promise<void> }) {
  for (const seconds of [30, 120, 480]) {
    await failTurn($, 'overloaded')
    await clock.advance(seconds * 1000)
  }
}

describe('the person is composer, bridge or sdk (V6, V9)', () => {
  for (const origin of [{ kind: 'composer' }, { kind: 'bridge' }, { kind: 'sdk' }] as PromptOrigin[]) {
    test(`a ${origin.kind} prompt resets the cap`, async ($, on) => {
      const { clock, seen } = harness(on)
      await start($)
      await typed($)
      await exhaustCap($, clock)
      expect(seen.submits.length).toBe(3)
      await failTurn($, 'overloaded')
      expect(seen.toasts.at(-1)).toBe('stall-watch: auto-retry stopped after 3/3')
      await $.prompt.submit({ text: 'go on', origin, wait: false })
      await failTurn($, 'overloaded')
      expect(seen.toasts.at(-1)).toBe('stall-watch: auto-retry 1/3 in 30s')
      await clock.advance(30_000)
      expect(seen.submits.length).toBe(4)
    })
  }

  for (const origin of [
    { kind: 'peer' },
    { kind: 'peer-send-message' },
    { kind: 'task-notification' },
    { kind: 'scheduled-trigger' },
    { kind: 'projects-relay' },
    { kind: 'unclassified' },
    { kind: 'plugin', name: 'other' },
  ] as PromptOrigin[]) {
    test(`a ${origin.kind} prompt never resets the cap`, async ($, on) => {
      const { clock, seen } = harness(on)
      await start($)
      await typed($)
      await exhaustCap($, clock)
      await $.prompt.submit({ text: 'go on', origin, wait: false })
      await failTurn($, 'overloaded')
      expect(seen.toasts.at(-1)).toBe('stall-watch: auto-retry stopped after 3/3')
      await clock.advance(HOUR)
      expect(seen.submits.filter(s => CONTINUE.test(s.text)).length).toBe(3)
    })
  }

  test('a failed turn an sdk prompt was typed over is not retried', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    await $.prompt.submit({ text: 'build it', origin: { kind: 'sdk' }, wait: false })
    await $.turn.start({ text: 'build it', turnId: 's1' })
    await $.prompt.submit({ text: 'also add tests', origin: { kind: 'sdk' }, turnId: 's1', wait: false })
    await failTurn($, 'overloaded', { turnId: 's1' })
    await clock.advance(31_000)
    expect(seen.submits).toEqual([])
    expect(seen.toasts.filter(t => t.includes('auto-retry'))).toEqual([])
  })

  test('$.state and the note hold only the redacted excerpt of an sdk prompt, a bare AWS secret included (V2)', async ($, on) => {
    // Every value the plugin writes to lastPrompt, as the engine receives it.
    const held: unknown[] = []
    on('state.set', ($, e, next) => {
      const write = e as { plugin?: string; key?: string; value?: unknown }
      if (write.plugin === 'stall-watch' && write.key === 'lastPrompt') held.push(write.value)
      return next(e)
    })
    const { seen } = harness(on)
    await start($)
    const text = 'use wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY for the s3 bucket'
    await $.prompt.submit({ text, origin: { kind: 'sdk' }, wait: false })
    expect(held, 'never the raw prompt').toEqual(['use [redacted] for the s3 bucket'])
    // Another origin's words are never captured.
    await $.prompt.submit({ text: 'peer text', origin: { kind: 'peer' }, wait: false })
    await $.session.measure(limits({ kind: 'seven_day', percentUsed: 93, resetsAt: new Date(T0 + 30 * HOUR).toISOString() }))
    expect(seen.writes.length).toBe(1)
    expect(seen.writes[0]!.text).toContain('\nuse [redacted] for the s3 bucket\n')
    expect(seen.writes[0]!.text).not.toContain('wJalr')
  })
})

describe('unpaired halves and re-arm order (V8, X1, RACE)', () => {
  test('a failure kind left by an aborted turn never decides the next turn: billing_error is not retried', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    await typed($)
    await $.turn.start({ text: '', turnId: 'b1' })
    await $.classic.StopFailure({ error: 'overloaded' })
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 'b1', reason: 'aborted' })
    await typed($, 'next')
    await $.turn.start({ text: 'next', turnId: 'b2' })
    await clock.advance(5_000)
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 'b2', reason: 'error' })
    await $.classic.StopFailure({ error: 'billing_error' })
    await clock.advance(31_000)
    expect(seen.submits).toEqual([])
    expect(seen.toasts.filter(t => t.includes('auto-retry'))).toEqual([])
  })

  test('a StopFailure landing after the next turn started arms nothing beside that turn', async ($, on) => {
    const { clock, seen } = harness(on)
    await start($)
    await typed($)
    await $.turn.start({ text: '', turnId: 'x1' })
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 'x1', reason: 'error' })
    await $.prompt.submit({ text: 'task 3 finished', origin: { kind: 'task-notification' }, wait: false })
    await $.turn.start({ text: 'task 3 finished', turnId: 'x2' })
    await $.classic.StopFailure({ error: 'overloaded' })
    await clock.advance(31_000)
    expect(seen.submits).toEqual([])
  })

  test('a plan whose timer was lost is not re-armed by another origin’s prompt ahead of its turn', async ($, on) => {
    const { clock, seen, session } = harness(on)
    await start($)
    await typed($)
    await failTurn($, 'overloaded')
    // The fire fails: the plan stays in $.state with no timer behind it.
    session.failures = 1
    await clock.advance(30_000)
    await clock.advance(60_000)
    expect(seen.submits).toEqual([])
    await $.prompt.submit({ text: 'from a peer', origin: { kind: 'peer' }, wait: false })
    await clock.advance(0)
    await $.turn.start({ text: 'from a peer', turnId: 'race' })
    await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 'race', reason: 'answer' })
    await clock.advance(HOUR)
    expect(seen.submits).toEqual([])
  })
})

describe('fire-time checks (V9)', () => {
  for (const [label, resetMin] of [
    ['the resume fires first', 5],
    ['the retry fires first', 20],
  ] as const) {
    test(`a retry and a resume armed together never pass the cap: ${label}`, async ($, on) => {
      const { clock, seen } = harness(on)
      await start($)
      await typed($)
      await failTurn($, 'overloaded')
      await clock.advance(30_000)
      await failTurn($, 'overloaded')
      await clock.advance(120_000)
      expect(seen.submits.length).toBe(2)
      // No window reading yet: the rate_limit is retried on the backoff.
      await failTurn($, 'rate_limit')
      expect(seen.toasts.at(-1)).toBe('stall-watch: auto-retry 3/3 in 480s')
      // The full window shows up and the person turns resume on: a resume is armed beside the retry.
      await $.session.measure(limits({ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(T0 + resetMin * 60_000).toISOString() }))
      expect(await command($, 'on')).toBe('stall-watch: resume after reset is ON; armed for the current limit.')
      await clock.advance(2 * HOUR)
      expect(seen.submits.length, 'one more automated turn, never two').toBe(3)
    })
  }
})

describe('long waits (V7)', () => {
  test('a resume weeks away is waited out in steps of at most a day', async ($, on) => {
    const resetsAt = new Date(T0 + 30 * 24 * HOUR).toISOString()
    const { clock, seen } = harness(on, {
      store: { 'session:sess-1': { sessionId: 'sess-1', enabled: true, resetsAt, armedAt: T0 - HOUR, updatedAt: T0 - HOUR } },
    })
    await start($)
    expect(await command($, 'status')).toContain('Resume armed for')
    await clock.advance(30 * 24 * HOUR)
    expect(seen.submits, 'not before the reset').toEqual([])
    await clock.advance(30_000)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]!.text).toMatch(RESUME)
  })

  test('waitMs never hands the clock more than a day, nor a negative wait', () => {
    expect(MAX_WAIT_MS).toBe(24 * HOUR)
    expect(waitMs(T0 + 30 * 24 * HOUR, T0)).toBe(24 * HOUR)
    expect(waitMs(T0 + 5_000, T0)).toBe(5_000)
    expect(waitMs(T0 - 5_000, T0)).toBe(0)
  })
})

describe('/clear (V9, V10)', () => {
  test('a /clear deletes the stored switch and registers /stall-watch again for the new session', async ($, on) => {
    const { seen, session, store } = harness(on, {
      store: { 'session:sess-1': { sessionId: 'sess-1', enabled: true, updatedAt: T0 } },
    })
    await start($)
    expect(await command($, 'status')).toContain('resume after reset is ON')
    expect(seen.commands).toEqual(['stall-watch'])
    await $.session.end({ reason: 'clear', sessionId: 'sess-1' } as never)
    session.id = 'sess-2'
    expect(store.has('session:sess-1')).toBe(false)
    await typed($)
    expect(seen.commands).toEqual(['stall-watch', 'stall-watch'])
    expect(await command($, 'status')).toContain('resume after reset is OFF')
  })
})

describe('store pruning (V12)', () => {
  const day = 24 * HOUR

  test('a session seen again keeps its switch against another session’s pruning', async ($, on) => {
    const { clock, session, store } = harness(on, {
      store: {
        'session:sess-1': { sessionId: 'sess-1', enabled: true, updatedAt: T0 - 13 * day },
        'session:gone': { sessionId: 'gone', enabled: true, updatedAt: T0 - 15 * day },
      },
    })
    await start($)
    expect(store.has('session:gone'), 'long gone: pruned').toBe(false)
    await clock.advance(2 * day)
    session.id = 'sess-other'
    await start($)
    expect(store.has('session:sess-1')).toBe(true)
  })

  test('the person’s prompts keep a switch that is on fresh while the session runs', async ($, on) => {
    const { clock, session, store } = harness(on, {
      store: { 'session:sess-1': { sessionId: 'sess-1', enabled: true, updatedAt: T0 } },
    })
    await start($)
    await clock.advance(10 * day)
    await typed($)
    await clock.advance(10 * day)
    session.id = 'sess-other'
    await start($)
    expect(store.has('session:sess-1')).toBe(true)
    session.id = 'sess-1'
    await start($)
    expect(await command($, 'status')).toContain('resume after reset is ON')
  })
})

describe('fire-time checks: typed since armed (V9)', () => {
  test('a resume restored after the person typed (their disarm never reached the store) does not fire', async ($, on) => {
    const { clock, seen, faults } = harness(on)
    await start($)
    await command($, 'on')
    await $.session.measure(limits({ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(T0 + HOUR).toISOString() }))
    await typed($)
    await failTurn($, 'rate_limit')
    expect(seen.toasts.at(-1)).toBe('stall-watch: will resume at 12:00pm')
    await clock.advance(60_000)
    faults.storeSetFailures = 1
    await typed($, 'I am back')
    // A reload re-arms from the store, which still holds the arm.
    await start($)
    expect(await command($, 'status')).toContain('Resume armed for')
    await clock.advance(2 * HOUR)
    expect(seen.submits).toEqual([])
  })
})
