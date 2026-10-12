// rd-ledger: kit tests for the hooks module (SPEC §11 item 10), each on the
// shared world beneath the plugin (hooks/testing/world.ts). Every test ends by
// asserting that no argv named an executable off the allowlist and that
// $.ui.status was never called.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { IMPORT_PROGRAM } from './bridge'
import { EXPORT_FILES } from './exporter'
import { sha256 } from './hash'
import { priceTurn } from './prices'
import { footerLabel } from './report'
import { encodeSession, newSegment, rootHashOf } from './store'
import { corpus, HINT, HOME, MODE, PANE, PYTHON, RDT_REPO, SID, SID2, STORE, T0, world, yieldTurns, FOUR_MIB } from './testing/world'
import type { World, WorldOptions } from './testing/world'

const ZONE = 'America/New_York'
const USAGE = 'Usage: /rd [session [<first 8 of a session id>] | sessions | review | spend | export [YYYY | YYYY-MM] | import]'
const SALT = 'a'.repeat(32)
const MAPPING = {
  v: 1,
  gen: 3,
  entities: { acme: { name: 'Example Co', filing: 'c-corp' } },
  components: { 'acme-app': { name: 'Example App', entity: 'acme', activity: 'direct_research', poe: false, rdt: 'acme-app' } },
  repos: {},
  pretag: [],
}
const SENTINEL = `SNTL-7f3a9c e@x.test ghp_${'A1b2C3d4E5'.repeat(4)}`
const BRIDGE_REPO_FILES = {
  [`${RDT_REPO}/rdt/__init__.py`]: '',
  [`${RDT_REPO}/registries/components.yaml`]: 'components: {}\n',
  [`${RDT_REPO}/.venv/bin/python`]: '',
}

/** A store that already froze its zone and salt, so the tests never depend on this machine's zone. */
const files = (extra: Record<string, string> = {}): Record<string, string> => ({ [`${STORE}/timezone`]: `${ZONE}\n`, [`${STORE}/salt`]: `${SALT}\n`, ...extra })
const withMapping = (mapping: object = MAPPING, extra: Record<string, string> = {}) => files({ [`${STORE}/components.json`]: JSON.stringify(mapping), ...extra })
/** The world, plus the two classic events nothing beneath the plugins answers in the kit. */
const make = (on: Parameters<typeof world>[0], options: WorldOptions = {}) => {
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  return world(on, Object.assign(options, { files: options.files ?? files() }))
}

async function start($: Engine, w: World, surface: 'terminal' | 'desktop' | 'mobile' = 'desktop') {
  await $.session.start({ cwd: `${HOME}/shop`, surface, isInteractive: true } as never)
  await w.clock.settle()
}
const submit = ($: Engine, origin: Record<string, unknown> = { kind: 'composer' }, extra: Record<string, unknown> = {}) =>
  $.prompt.submit({ text: 'hello', wait: false, origin, ...extra } as never)
const turn = ($: Engine, turnId: string, extra: Record<string, unknown> = {}) =>
  $.turn.complete({
    answer: '',
    durationMs: 2000,
    isAborted: false,
    turnId,
    reason: 'answer',
    usage: { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400 },
    ...extra,
  } as never)
const rd = ($: Engine, args = '', origin: Record<string, unknown> = { kind: 'composer' }) =>
  $.command.run({ command: 'rd', args, origin: origin as never, presentation: { isFullscreen: true, columns: 160 } })

/** The final segment files (no temps), sorted. */
const segments = (w: World): string[] => [...w.files.keys()].filter(p => p.startsWith(`${STORE}/sessions/`) && /\.json$/.test(p)).sort()
const record = (w: World, path: string) => JSON.parse(w.files.get(path)?.text ?? 'null')
const mvs = (w: World) => w.argv.filter(a => a[0] === '/bin/mv')
/** The rollup is kept shape-tagged (`{ shape, value }`); the other values are kept bare. */
const unshape = (v: unknown): unknown => (typeof v === 'object' && v !== null && 'shape' in v && 'value' in v ? (v as { value: unknown }).value : v)
const rollups = (w: World) => w.stateSets.map(unshape).filter(v => typeof v === 'object' && v !== null && 'weekRows' in v) as Record<string, unknown>[]
const lastRollup = (w: World) => rollups(w).at(-1)
const rollupCount = (w: World) => rollups(w).length

/** The two invariants every test ends on. */
function clean(w: World) {
  expect(w.disallowed).toEqual([])
  expect(w.statuses).toEqual([])
}

describe('open, continue and close', () => {
  test('session.start registers /rd, opens one segment and keeps its rows across a second start', async ($, on) => {
    const w = make(on)
    await start($, w)
    expect(w.registered).toEqual(['rd'])
    expect(segments(w)).toEqual([`${STORE}/sessions/2026/10/${SID}.${T0.toString(36)}.json`])
    await submit($)
    await start($, w)
    expect(segments(w)).toHaveLength(1)
    const r = record(w, segments(w)[0] as string)
    expect(r.events).toHaveLength(1)
    expect(r.repoKey).toBe('shop')
    expect(r.rootHash).toMatch(/^[0-9a-f]{12}$/)
    expect(r.entrypoint).toBe('claude-desktop')
    clean(w)
  })

  test('a corrupt file at recordPath is never rewritten: zero mv onto it, a new segment', async ($, on) => {
    const w = make(on)
    await start($, w)
    // Let the start's own branch flush land first; then the file is torn, as a crash mid-write would leave it.
    await w.clock.advance(1000)
    const first = segments(w)[0] as string
    w.files.set(first, { text: '{"v":1,"sessionId":', mtimeMs: T0, size: 19 })
    const before = mvs(w).length
    await start($, w)
    await w.clock.advance(1000)
    expect(mvs(w).slice(before).some(a => a[a.length - 1] === first)).toBe(false)
    expect(w.files.get(first)?.text).toBe('{"v":1,"sessionId":')
    expect(segments(w)).toHaveLength(2)
    clean(w)
  })

  test('a second process resuming the same id writes a second segment', async ($, on) => {
    // The first process's open segment for the same id, left by a process that is still running.
    const other = `${STORE}/sessions/2026/10/${SID}.${(T0 - 60_000).toString(36)}.json`
    const w = make(on, { files: files({ [other]: JSON.stringify({ v: 1, sessionId: SID, seg: (T0 - 60_000).toString(36), openedAt: T0 - 60_000, closedAt: null, closeReason: null, source: 'startup', entrypoint: 'claude-desktop', interactive: true, surface: 'desktop', repoKey: 'shop', repoKind: 'repo', rootHash: null, cwdBase: 'shop', branch: null, branchChanges: [], model: null, cacheTtlChanges: [], nextSeq: 2, events: [{ seq: 1, ts: T0 - 50_000, origin: 'composer', admit: 1, reason: 'human', queued: 0 }], turns: [], eventsDropped: 0, turnsDropped: 0, malformedRows: 0, redactions: 0, engineCostAtOpen: 0, engineCostUsd: null, updatedAt: T0 - 50_000 }) }) })
    const otherText = w.files.get(other)?.text
    await start($, w)
    await $.classic.SessionStart({ source: 'resume', session_id: SID } as never)
    await submit($)
    await w.clock.advance(1000)
    expect(segments(w)).toHaveLength(2)
    // A writer rewrites only the segment it opened.
    expect(w.files.get(other)?.text).toBe(otherText)
    const mine = record(w, segments(w).find(p => p !== other) as string)
    expect(mine.source).toBe('resume')
    expect(mine.events).toHaveLength(1)
    clean(w)
  })

  test('/clear closes the old segment with clear and opens the new id\'s', async ($, on) => {
    const w = make(on)
    await start($, w)
    await submit($)
    await w.clock.advance(1000)
    await $.session.end({ reason: 'clear', sessionId: SID } as never)
    w.sessionId = SID2
    await $.classic.SessionStart({ source: 'clear', session_id: SID2 } as never)
    await w.clock.settle()
    const all = segments(w)
    expect(all).toHaveLength(2)
    const old = record(w, all.find(p => p.includes(SID)) as string)
    expect(old.closeReason).toBe('clear')
    expect(old.closedAt).toBe(T0 + 1000)
    const fresh = record(w, all.find(p => p.includes(SID2)) as string)
    expect(fresh.source).toBe('clear')
    expect(fresh.closedAt).toBeNull()
    await submit($)
    expect(record(w, all.find(p => p.includes(SID2)) as string).events).toHaveLength(1)
    clean(w)
  })

  test('month rollover at 23:59:59.999 local: the next millisecond opens November\'s segment', async ($, on) => {
    const w = make(on)
    // 2026-10-31 23:59:59.000 in New York (EDT, UTC-4).
    const lateOct = Date.UTC(2026, 10, 1, 3, 59, 59, 0)
    await w.clock.set(lateOct)
    await start($, w)
    await w.clock.set(lateOct + 999)
    await submit($)
    expect(segments(w).filter(p => p.includes('/2026/11/'))).toHaveLength(0)
    await w.clock.set(lateOct + 1000)
    await submit($)
    const oct = segments(w).filter(p => p.includes('/2026/10/'))
    const nov = segments(w).filter(p => p.includes('/2026/11/'))
    expect(oct).toHaveLength(1)
    expect(nov).toHaveLength(1)
    expect(record(w, oct[0] as string).events).toHaveLength(1)
    expect(record(w, oct[0] as string).closeReason).toBe('month')
    expect(record(w, nov[0] as string).events).toHaveLength(1)
    clean(w)
  })
})

describe('capture and flush', () => {
  test('an event is written at once; turns coalesce into one flush 500 ms later', async ($, on) => {
    const w = make(on)
    await start($, w)
    const before = mvs(w).length
    await submit($)
    expect(mvs(w).length).toBe(before + 1)
    const path = segments(w)[0] as string
    expect(record(w, path).events).toHaveLength(1)
    const afterEvent = mvs(w).length
    await turn($, 't-1')
    await turn($, 't-2', { agentId: 'agent-7' })
    await w.clock.advance(499)
    expect(mvs(w).length).toBe(afterEvent)
    expect(record(w, path).turns).toHaveLength(0)
    await w.clock.advance(1)
    expect(mvs(w).length).toBe(afterEvent + 1)
    const turns = record(w, path).turns
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ turnId: 't-1', agent: 0, agentKey: '', model: 'claude-opus-5-5', in: 1000, out: 500, cr: 2000, cw: 400, reason: 'answer' })
    expect(turns[1].agent).toBe(1)
    expect(turns[1].agentKey).toMatch(/^[0-9a-f]{8}$/)
    clean(w)
  })

  test('two flushes back to back leave one whole final file holding both events', async ($, on) => {
    const w = make(on)
    await start($, w)
    await Promise.all([submit($), submit($, { kind: 'bridge' })])
    await w.clock.settle()
    const r = record(w, segments(w)[0] as string)
    expect(r.events.map((ev: { seq: number }) => ev.seq)).toEqual([1, 2])
    expect([...w.files.keys()].filter(p => p.includes('.tmp.'))).toEqual([])
    clean(w)
  })

  test('mv exit 1 keeps the segment dirty, sets lastError, and retries with backoff', async ($, on) => {
    const options: WorldOptions = { mvExit: 1 }
    const w = make(on, options)
    await start($, w)
    await submit($)
    expect(segments(w)).toEqual([])
    expect(String([...w.stateSets].reverse().find(v => typeof v === 'string' && v.includes('retrying')))).toContain('could not be replaced')
    // Retries back off (1 s, 2 s, 4 s, ... up to a minute) rather than spinning.
    const c0 = mvs(w).length
    await w.clock.advance(60_000)
    const tries = mvs(w).length - c0
    expect(tries).toBeGreaterThanOrEqual(3)
    expect(tries).toBeLessThanOrEqual(8)
    // No temp is left behind by a failed swap.
    expect([...w.files.keys()].filter(p => p.includes('.tmp.'))).toEqual([])
    // The disk recovers: the next retry writes the whole segment, the event included, and clears the error.
    options.mvExit = 0
    await w.clock.advance(60_000)
    expect(record(w, segments(w)[0] as string).events).toHaveLength(1)
    expect([...w.stateSets].reverse().find(v => v === null || (typeof v === 'string' && v.startsWith('rd-ledger:')))).toBeNull()
    clean(w)
  })

  test('session.end runs core\'s end beside a held flush and closes the segment', { timeoutMs: 15_000 }, async ($, on) => {
    const w = make(on)
    await start($, w)
    let release = () => {}
    w.hold = new Promise<void>(resolve => {
      release = resolve
    })
    const at = w.order.length
    const ended = $.session.end({ reason: 'prompt_input_exit', sessionId: SID } as never)
    await yieldTurns(2000)
    // Core's end ran while the segment's mv was still held.
    expect(w.order.slice(at)).toEqual(['core-end'])
    w.hold = null
    release()
    await ended
    expect(w.order.slice(at)).toEqual(['core-end', 'mv'])
    await w.clock.settle()
    const r = record(w, segments(w)[0] as string)
    expect(r.closedAt).toBe(T0)
    expect(r.closeReason).toBe('prompt_input_exit')
    clean(w)
  })

  test('session.measure and a model switch mark the segment: own cost and a TTL change point', async ($, on) => {
    const w = make(on)
    await start($, w)
    await $.session.measure({ context: { window: 1_000_000, percent: 5 }, rateLimits: [], cost: { usd: 2.5 }, changed: ['cost'] } as never)
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', source: 'command', prompt_cache_warm: false, cache_ttl: '1h' } as never)
    await w.clock.advance(500)
    const r = record(w, segments(w)[0] as string)
    expect(r.engineCostUsd).toBe(2.5)
    expect(r.cacheTtlChanges).toEqual([{ ts: T0, ttl: '1h' }])
    clean(w)
  })
})

describe('privacy', () => {
  test('the sentinel never reaches a file, an argv, a toast, a log, state, the pane or an export', async ($, on) => {
    const w = make(on, { files: withMapping() })
    await start($, w)
    const origins = [{ kind: 'composer' }, { kind: 'bridge' }, { kind: 'sdk' }, { kind: 'task-notification' }, { kind: 'plugin', name: 'other-mod' }]
    for (const origin of origins) {
      await submit($, origin, { text: SENTINEL, attachments: [{ kind: 'image', name: SENTINEL }], context: [SENTINEL] })
    }
    await w.clock.advance(5000)
    const ui = await $.ui.mount({ plugin: 'rd-ledger', surface: 'terminal', ...PANE })
    let drawn = JSON.stringify(await ui.drawn())
    await ui.press({ key: 'view-review' })
    drawn += JSON.stringify(await ui.drawn())
    await ui.unmount()
    await rd($, 'export')
    expect([...w.files.keys()].filter(p => p.includes('/export/'))).toHaveLength(EXPORT_FILES.length + 1)
    expect(corpus(w)).not.toContain('SNTL-7f3a9c')
    expect(corpus(w)).not.toContain('e@x.test')
    expect(corpus(w)).not.toContain('ghp_A1b2')
    expect(drawn).not.toContain('SNTL-7f3a9c')
    // Every stored event has exactly the six schema keys.
    for (const path of segments(w)) {
      for (const ev of record(w, path).events) expect(Object.keys(ev).sort()).toEqual(['admit', 'origin', 'queued', 'reason', 'seq', 'ts'])
    }
    const events = segments(w).flatMap(p => record(w, p).events)
    expect(events.map((ev: { reason: string }) => ev.reason)).toEqual(['human', 'human', 'human-desktop-host', 'origin:task-notification', 'origin:plugin'])
    clean(w)
  })
})

// --- fixtures for the views, the review and the bridge ---------------------------------------

const HASH = rootHashOf(SALT, `${HOME}/shop`, HOME)
const ROW = 'acme-app|2026-10-11'
const MAPPED = { ...MAPPING, repos: { [`shop#${HASH}`]: { component: 'acme-app' } } }
const bridged = (extra: Record<string, string> = {}, mapping: object = MAPPED) => withMapping(mapping, { ...BRIDGE_REPO_FILES, ...extra })

/** Three prompts ten minutes apart from T0: one 1200 s block on Sunday 2026-10-11, then a fresh rollup. */
async function engage($: Engine, w: World) {
  for (let i = 0; i < 3; i += 1) {
    await submit($)
    await w.clock.advance(600_000)
  }
  await rd($, '', { kind: 'peer' })
  await w.clock.settle()
}
const pane = ($: Engine, surface: 'terminal' | 'desktop' | 'mobile' = 'desktop') => $.ui.mount({ plugin: 'rd-ledger', surface, ...PANE })
const review = (w: World, week = '2026-W41') => JSON.parse(w.files.get(`${STORE}/reviews/${week}.json`)?.text ?? 'null')
const bridgeLog = (w: World) => (w.files.get(`${STORE}/bridge-2026.ndjson`)?.text ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
const adds = (w: World) => w.argv.filter(a => a[0] === PYTHON && a.includes('add'))

describe('/rd per origin', () => {
  test('the person opens the pane; a peer gets one summary line; an unknown word gets the usage line', async ($, on) => {
    const w = make(on, { files: withMapping(MAPPED) })
    await start($, w)
    await engage($, w)
    expect((await rd($)).text).toBe('R&D ledger pane opened.')
    expect((await rd($, 'review', { kind: 'bridge' })).text).toBe('R&D ledger pane opened.')
    expect((await rd($, '', { kind: 'sdk' })).text).toBe('R&D ledger pane opened.')
    expect(w.opened).toEqual(['rd-ledger', 'rd-ledger', 'rd-ledger'])
    for (const origin of [{ kind: 'peer' }, { kind: 'task-notification' }, { kind: 'plugin', name: 'x' }, { kind: 'scheduled-trigger' }]) {
      const text = (await rd($, '', origin)).text ?? ''
      expect(text).toMatch(/^R&D: 0\.33 h this week · 0\.33 h today · 0 unmapped · week 2026-W41 open$/)
    }
    expect(w.opened).toHaveLength(3)
    expect((await rd($, 'bogus')).text).toBe(USAGE)
    clean(w)
  })

  test('a non-person origin in a headless session gets one summary line, never the overview (verifier V7)', async ($, on) => {
    const w = make(on, { isHeadless: true })
    await start($, w)
    const r = await $.command.run({ command: 'rd', args: '', origin: { kind: 'peer' }, presentation: { isFullscreen: false, columns: 100 } })
    expect(r.text.startsWith('R&D:')).toBe(true)
    expect(r.text.includes('This week')).toBe(false)
  })

  test('an sdk origin on a terminal session is not the person', async ($, on) => {
    const w = make(on, { surfaces: ['terminal'] })
    await start($, w, 'terminal')
    expect((await rd($, '', { kind: 'sdk' })).text).toMatch(/^R&D: /)
    expect(w.opened).toEqual([])
    clean(w)
  })

  test('where the pane cannot be placed the person gets the overview text', async ($, on) => {
    const w = make(on, { isPlaced: false })
    await start($, w)
    expect((await rd($)).text).toMatch(/^This week /)
    clean(w)
  })

  test('headless: no pane, the text answers', async ($, on) => {
    const w = make(on, { isHeadless: true })
    await start($, w)
    expect((await rd($)).text).toMatch(/^This week /)
    expect((await rd($, 'spend')).text).toMatch(/^Spend · list-price estimate, not an invoice/)
    expect(w.opened).toEqual([])
    clean(w)
  })
})

describe('the pane', () => {
  test('the three views draw on terminal, desktop and mobile; mobile says to use the terminal or desktop', async ($, on) => {
    const w = make(on, { files: withMapping(MAPPING) })
    await start($, w)
    await engage($, w)
    for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
      const ui = await pane($, surface)
      expect(await ui.find({ type: 'Text', text: /^This week / })).toBeDefined()
      await ui.press({ key: 'view-review' })
      expect(await ui.find({ type: 'Text', text: /^Review 2026-W41 · open/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /shop#[0-9a-f]{12}/ })).toBeDefined()
      if (surface === 'mobile') {
        expect(await ui.find({ type: 'Text', text: /Use the terminal or the desktop/ })).toBeDefined()
        expect(JSON.stringify(await ui.drawn())).not.toContain('"Select"')
      } else {
        expect(await ui.find({ key: `map:shop#${HASH}` })).toBeDefined()
        expect(await ui.find({ key: 'confirm' })).toBeDefined()
      }
      await ui.press({ key: 'view-spend' })
      expect(await ui.find({ type: 'Text', text: /^Spend · list-price estimate/ })).toBeDefined()
      await ui.press({ key: 'view-overview' })
      await ui.unmount()
    }
    clean(w)
  })

  test('a Select pick writes key#hash at gen + 1 with a history line, and the queue empties', async ($, on) => {
    const w = make(on, { files: withMapping(MAPPING) })
    await start($, w)
    await engage($, w)
    const ui = await pane($)
    await ui.press({ key: 'view-review' })
    await ui.select({ key: `map:shop#${HASH}`, value: 'c:acme-app' })
    await w.clock.settle()
    const saved = JSON.parse(w.files.get(`${STORE}/components.json`)?.text ?? '{}')
    expect(saved.gen).toBe(4)
    expect(saved.repos[`shop#${HASH}`]).toEqual({ component: 'acme-app' })
    const history = (w.files.get(`${STORE}/mapping-history.ndjson`)?.text ?? '').trim().split('\n')
    expect(history).toHaveLength(1)
    expect(JSON.parse(history[0] as string).gen).toBe(4)
    expect((lastRollup(w)?.['queue'] as unknown[]).length).toBe(0)
    expect(await ui.find({ type: 'Text', text: /2026-10-11  acme-app/ })).toBeDefined()
    await ui.unmount()
    clean(w)
  })

  test('a mapping the loader had to drop entries from is never saved over', async ($, on) => {
    const broken = { ...MAPPING, components: { ...MAPPING.components, 'Bad Id': { name: 'x', entity: 'acme', activity: 'direct_research', poe: false } } }
    const w = make(on, { files: withMapping(broken) })
    await start($, w)
    await engage($, w)
    const before = w.files.get(`${STORE}/components.json`)?.text
    const ui = await pane($)
    await ui.press({ key: 'view-review' })
    expect(await ui.find({ type: 'Text', text: /^components\.json: \d+ problem/ })).toBeDefined()
    await ui.select({ key: `map:shop#${HASH}`, value: 'ignore' })
    await w.clock.settle()
    expect(w.files.get(`${STORE}/components.json`)?.text).toBe(before)
    expect(w.toasts.some(t => /a save would erase/.test(t))).toBe(true)
    await ui.unmount()
    clean(w)
  })

  test('POE on without a note is refused with a toast; with a note it becomes a draft; Confirm freezes the seconds; Reopen', async ($, on) => {
    const w = make(on, { files: withMapping(MAPPED) })
    await start($, w)
    await engage($, w)
    const ui = await pane($)
    await ui.press({ key: 'view-review' })
    const sets = w.stateSets.length
    await ui.press({ key: `poe:${ROW}` })
    await w.clock.settle()
    expect(w.toasts.at(-1)).toBe('R&D ledger: add a note for acme-app (2026-W41) before turning POE on.')
    expect(w.stateSets.slice(sets).some(v => typeof v === 'object' && v !== null && ROW in v)).toBe(false)
    await ui.input({ key: 'note:acme-app', text: 'Tried two cache layouts; the second held p95 under 40 ms.' })
    await ui.press({ key: `act:${ROW}:support` })
    await ui.press({ key: `poe:${ROW}` })
    await w.clock.settle()
    expect(await ui.find({ type: 'Text', text: /acme-app .* Support {2}POE {2}\[draft\]/ })).toBeDefined()
    await ui.press({ key: 'confirm' })
    await w.clock.settle()
    const file = review(w)
    expect(file.revisions).toHaveLength(1)
    const rev = file.revisions[0]
    expect(rev).toMatchObject({ rev: 1, kind: 'confirm', confirmedAt: T0 + 1_800_000, method: 'union-v2/a5db146c', zone: ZONE, confirmedLagDays: 0 })
    expect(rev.rows[ROW]).toEqual({ seconds: 1200, entity: 'acme', activity: 'direct_support', poe: true, source: 'confirmed' })
    expect(rev.notes['acme-app|2026-W41']).toBe('Tried two cache layouts; the second held p95 under 40 ms.')
    expect(rev.inputsDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(rev.mappingDigest).toBe(sha256(JSON.stringify(MAPPED)))
    expect(await ui.find({ type: 'Text', text: /^Review 2026-W41 · confirmed rev 1/ })).toBeDefined()
    await ui.press({ key: 'reopen' })
    await w.clock.settle()
    expect(review(w).revisions.map((r: { kind: string }) => r.kind)).toEqual(['confirm', 'reopen'])
    expect(await ui.find({ key: 'reopen' })).toBeUndefined()
    await ui.unmount()
    clean(w)
  })

  test('two Confirm presses at once write one revision', async ($, on) => {
    const w = make(on, { files: withMapping(MAPPED) })
    await start($, w)
    await engage($, w)
    const ui = await pane($)
    await ui.press({ key: 'view-review' })
    await Promise.all([ui.press({ key: 'confirm' }), ui.press({ key: 'confirm' })])
    await w.clock.settle()
    expect(review(w).revisions).toHaveLength(1)
    await ui.unmount()
    clean(w)
  })

  test('the footer: the hourglass mark and today\'s R&D hours as a Button chip on the desktop and after the engine\'s hint on the terminal; a press opens the Overview', async ($, on) => {
    const seen = recordTodayS(on)
    const w = make(on, { files: withMapping(MAPPED) })
    await start($, w)
    await engage($, w)
    // The footer draws the last rollup; past the 60 s staleness a command refreshes it.
    await w.clock.advance(61_000)
    await rd($, '', { kind: 'peer' })
    await w.clock.settle()
    const mode = await $.ui.mount({ plugin: 'rd-ledger', surface: 'desktop', ...MODE })
    const chip = await mode.find({ key: 'rd-ledger' })
    expect(chip?.type).toBe('Button')
    // The figure is the rollup's today line, the one the Overview shows; the footer no longer carries a cost.
    const label = String(chip?.props['label'])
    expect(label).toMatch(/^\u29D7\d+\.\dh$/)
    // Exactly the rollup's todayS, through the one shared formatter: a chip wired to another field would differ.
    expect(seen.todayS).not.toBeNull()
    expect(label).toBe(footerLabel(seen.todayS))
    expect(label).not.toContain('$')
    expect([...label].length).toBeLessThanOrEqual(10)
    expect(/\p{Extended_Pictographic}/u.test(label)).toBe(false)
    // The engine's own SessionMode answer (the kit's bottom) is kept beside the chip.
    const drawn = (await mode.drawn()) as unknown as { type: string; children: { type: string; ref?: number }[] }
    expect(drawn.children.map(c => c.type)).toEqual(['Button', 'engine'])
    await mode.press({ key: 'rd-ledger' })
    await w.clock.settle()
    await mode.unmount()
    expect(w.stateSets).toContain('overview')
    expect(w.stateSets).not.toContain('session')
    const hint = await $.ui.mount({ plugin: 'rd-ledger', surface: 'terminal', ...HINT })
    const hinted = await hint.find({ key: 'rd-ledger' })
    expect(hinted?.type).toBe('Button')
    expect(hinted?.props['label']).toBe(label)
    await hint.unmount()
    expect(w.opened).toEqual(['rd-ledger'])
    const ui = await pane($)
    // The pane opened on the R&D tax ledger, not the Session view.
    expect(await ui.find({ type: 'Text', text: /Today/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Session 11111111/ })).toBeUndefined()
    await ui.unmount()
    clean(w)
  })

  test('before any rollup exists the chip still draws, as the hourglass and --', async ($, on) => {
    const w = make(on)
    const mode = await $.ui.mount({ plugin: 'rd-ledger', surface: 'desktop', ...MODE })
    expect((await mode.find({ key: 'rd-ledger' }))?.props['label']).toBe('\u29D7--')
    await mode.unmount()
    clean(w)
  })

  test('a press on the terminal chip opens the Overview too', async ($, on) => {
    const w = make(on, { files: withMapping(MAPPED) })
    await start($, w)
    await engage($, w)
    const hint = await $.ui.mount({ plugin: 'rd-ledger', surface: 'terminal', ...HINT })
    await hint.press({ key: 'rd-ledger' })
    await w.clock.settle()
    await hint.unmount()
    expect(w.stateSets).toContain('overview')
    expect(w.stateSets).not.toContain('session')
    expect(w.opened).toEqual(['rd-ledger'])
    clean(w)
  })

  test('with footerButton off the desktop figure is plain text, the hourglass and today\'s hours', { options: { footerButton: false } }, async ($, on) => {
    const seen = recordTodayS(on)
    const w = make(on)
    await start($, w)
    const mode = await $.ui.mount({ plugin: 'rd-ledger', surface: 'desktop', ...MODE })
    expect(await mode.find({ key: 'rd-ledger' })).toBeUndefined()
    // Exactly what the chip's own read produced: `⧗--` before a rollup exists, else today's hours.
    expect(await mode.find({ type: 'Text', text: footerLabel(seen.todayS) })).toBeDefined()
    await mode.unmount()
    clean(w)
  })

  test('a rollup that lacks todayS altogether draws the chip as ⧗--', async ($, on) => {
    on('state.get', { plugin: 'rd-ledger', key: 'rollup' }, (_$, e, next) =>
      next(e).then(r => {
        const read = (r as { value?: { value?: unknown; version: number } }).value
        const shaped = read?.value
        if (!read || typeof shaped !== 'object' || shaped === null || !('shape' in shaped)) return r
        const inner = (shaped as { value: unknown }).value
        if (typeof inner !== 'object' || inner === null) return r
        const { todayS: _t, ...rest } = inner as Record<string, unknown>
        return { value: { ...read, value: { ...shaped, value: rest } } }
      }) as never,
    )
    const w = make(on, { files: withMapping(MAPPED) })
    await start($, w)
    await engage($, w)
    const mode = await $.ui.mount({ plugin: 'rd-ledger', surface: 'desktop', ...MODE })
    expect((await mode.find({ key: 'rd-ledger' }))?.props['label']).toBe('\u29D7--')
    await mode.unmount()
    clean(w)
  })
})

async function confirmViaPane($: Engine, w: World) {
  const ui = await pane($)
  await ui.press({ key: 'view-review' })
  await ui.press({ key: 'confirm' })
  await w.clock.settle()
  await ui.unmount()
}
const RDT = { rdtRepo: RDT_REPO }
const REVIEW_JSON = JSON.stringify({ method: 'union-v2/a5db146c', sessions: [{ harness: 'claude_code', date: '2026-10-11', seconds: 3600 }, { harness: 'codex', date: '2026-10-11', seconds: 900 }] })
const ADD_ARGV = [PYTHON, '-I', '-m', 'rdt', 'add', '--date=2026-10-11', '--hours=0.33', '--entity=acme', '--component=acme-app', '--activity-type=direct_research', '--note=rd-ledger: week 2026-W41 rev 1']

describe('Compare', () => {
  test('runs rdt review --json for the week\'s Monday only after the Compare answer, never on open or refresh', { options: RDT }, async ($, on) => {
    const w = make(on, { files: bridged(), rdtReview: REVIEW_JSON })
    await start($, w)
    await engage($, w)
    const ui = await pane($)
    await ui.press({ key: 'view-review' })
    await ui.press({ key: 'refresh' })
    await w.clock.settle()
    expect(w.argv.filter(a => a[0] === PYTHON)).toEqual([])
    await ui.press({ key: 'compare' })
    await w.clock.settle()
    expect(w.asked.at(-1)).toMatch(/rd-tracker re-derives the week's proposals/)
    expect(w.argv.filter(a => a[0] === PYTHON)).toEqual([[PYTHON, '-I', '-m', 'rdt', 'review', '--json', '--week=2026-10-05']])
    expect(await ui.find({ type: 'Text', text: '  2026-10-11  ledger 0.33 h  rd-tracker 1.00 h  Δ -0.67  ! over 10 %' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  2026-10-10  ledger 0.00 h  rd-tracker 0.00 h  Δ 0.00' })).toBeDefined()
    await ui.unmount()
    clean(w)
  })

  test('a dismissed Compare runs nothing', { options: RDT }, async ($, on) => {
    const w = make(on, { files: bridged(), isDismissed: true })
    await start($, w)
    const ui = await pane($)
    await ui.press({ key: 'view-review' })
    await ui.press({ key: 'compare' })
    await w.clock.settle()
    expect(w.argv.filter(a => a[0] === PYTHON)).toEqual([])
    await ui.unmount()
    clean(w)
  })

  test('rdtRepo empty hides Compare', async ($, on) => {
    const w = make(on, { files: bridged() })
    await start($, w)
    const ui = await pane($)
    await ui.press({ key: 'view-review' })
    expect(await ui.find({ key: 'compare' })).toBeUndefined()
    await ui.unmount()
    clean(w)
  })

  test('bridgeMode off hides Compare', { options: { ...RDT, bridgeMode: 'off' } }, async ($, on) => {
    const w = make(on, { files: bridged() })
    await start($, w)
    const ui = await pane($)
    await ui.press({ key: 'view-review' })
    expect(await ui.find({ key: 'compare' })).toBeUndefined()
    expect(await ui.find({ key: 'confirm' })).toBeDefined()
    await ui.unmount()
    clean(w)
  })
})

describe('export and import', () => {
  test('/rd export writes the 14 files and a manifest that verifies; a planted ghp_ branch is redacted, not refused', async ($, on) => {
    const w = make(on, { files: withMapping(MAPPED), branch: `ghp_${'Z9y8X7w6V5'.repeat(4)}` })
    await start($, w)
    await engage($, w)
    const ran = await rd($, 'export 2026-10')
    expect(w.asked.at(-1)).toBe('Write 15 files to ~/.claude/rd-ledger/export/2026-10-11T0930/?')
    const dir = `${STORE}/export/2026-10-11T0930`
    const written = [...w.files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1)).sort()
    expect(written).toEqual([...EXPORT_FILES, 'MANIFEST.sha256'].sort())
    const manifest = (w.files.get(`${dir}/MANIFEST.sha256`)?.text ?? '').trim().split('\n')
    expect(manifest).toHaveLength(EXPORT_FILES.length)
    for (const line of manifest) {
      const [hash, name] = line.split('  ') as [string, string]
      expect(sha256(w.files.get(`${dir}/${name}`)?.text ?? '')).toBe(hash)
    }
    const all = written.map(n => w.files.get(`${dir}/${n}`)?.text ?? '').join('\n')
    expect(all).not.toContain('ghp_Z9y8')
    expect(all).toMatch(/\[redacted:[a-z-]+\]/)
    expect(all).not.toContain(HOME)
    expect(ran.text).toMatch(/^R&D ledger: exported 15 files to ~\/\.claude\/rd-ledger\/export\/2026-10-11T0930\/ · \d+ redactions?/)
    expect(w.toasts.at(-1)).toMatch(/exported 15 files/)
    clean(w)
  })

  test('a cancelled export writes nothing; a peer cannot export', async ($, on) => {
    const w = make(on, { answer: 'Cancel' })
    await start($, w)
    expect((await rd($, 'export')).text).toBe('R&D ledger: export cancelled.')
    expect((await rd($, 'export', { kind: 'peer' })).text).toMatch(/only from your own prompt/)
    expect([...w.files.keys()].some(p => p.includes('/export/'))).toBe(false)
    clean(w)
  })

  test('/rd import merges new ids from rd-tracker without overwriting', { options: RDT }, async ($, on) => {
    const imported = JSON.stringify({ entities: { acme: { name: 'Renamed' }, beta: { name: 'Beta LLC' } }, components: { 'beta-lab': { name: 'Beta Lab', entity: 'beta' } } })
    const w = make(on, { files: bridged({}, MAPPING), rdtImport: imported })
    await start($, w)
    const ran = await rd($, 'import')
    expect(ran.text).toBe('R&D ledger: imported 2: beta, beta-lab.')
    expect(w.argv.filter(a => a[0] === PYTHON)).toEqual([[PYTHON, '-I', '-c', IMPORT_PROGRAM, `${RDT_REPO}/registries/entities.yaml`, `${RDT_REPO}/registries/components.yaml`]])
    const saved = JSON.parse(w.files.get(`${STORE}/components.json`)?.text ?? '{}')
    expect(saved.gen).toBe(4)
    expect(saved.entities.acme.name).toBe('Example Co')
    expect(saved.components['beta-lab']).toMatchObject({ name: 'Beta Lab', entity: 'beta', rdt: 'beta-lab' })
    clean(w)
  })

  test('/rd import without the bridge says so and runs nothing', async ($, on) => {
    const w = make(on)
    await start($, w)
    expect((await rd($, 'import')).text).toMatch(/needs the rd-tracker repository/)
    expect(w.argv.filter(a => a[0] === PYTHON)).toEqual([])
    clean(w)
  })
})

const SOT = { rdtRepo: RDT_REPO, bridgeMode: 'source-of-truth' }

describe('the hand-off (source-of-truth)', () => {
  test('Confirm sends once per destination between an intent and a sent line; a second Confirm sends nothing', { options: SOT }, async ($, on) => {
    const w = make(on, { files: bridged() })
    await start($, w)
    await engage($, w)
    await confirmViaPane($, w)
    expect(w.asked.at(-1)).toBe('Record 1 entry for 2026-W41 in rd-tracker with rdt add?')
    expect(adds(w)).toEqual([ADD_ARGV])
    const log = bridgeLog(w)
    expect(log.map(l => l.kind)).toEqual(['intent', 'sent'])
    expect(log[1]).toMatchObject({ week: '2026-W41', rev: 1, date: '2026-10-11', rdtEntity: 'acme', rdtComponent: 'acme-app', hundredths: 33, exitCode: 0, rowId: 12, label: 'contemporaneous', lagDays: 0 })
    expect(log[0].argv[0]).toBe('python')
    expect(JSON.stringify(log)).not.toContain(HOME)
    await confirmViaPane($, w)
    expect(review(w).revisions).toHaveLength(2)
    expect(adds(w)).toHaveLength(1)
    expect(bridgeLog(w)).toHaveLength(2)
    clean(w)
  })

  test('exit 2 logs failed and the next Confirm retries', { options: SOT }, async ($, on) => {
    const w = make(on, { files: bridged(), rdtAdd: { stdout: '', exitCode: 2 } })
    await start($, w)
    await engage($, w)
    await confirmViaPane($, w)
    expect(bridgeLog(w).map(l => l.kind)).toEqual(['intent', 'failed'])
    await confirmViaPane($, w)
    expect(adds(w)).toHaveLength(2)
    clean(w)
  })

  test('exit 0 without a row id logs uncertain and is never re-sent', { options: SOT }, async ($, on) => {
    const w = make(on, { files: bridged(), rdtAdd: { stdout: 'something else\n', exitCode: 0 } })
    await start($, w)
    await engage($, w)
    await confirmViaPane($, w)
    expect(bridgeLog(w).map(l => l.kind)).toEqual(['intent', 'uncertain'])
    await confirmViaPane($, w)
    expect(adds(w)).toHaveLength(1)
    expect(w.toasts.at(-1)).toMatch(/1 blocked \(an earlier hand-off is pending or uncertain\)/)
    clean(w)
  })

  test('a rejected spawn logs uncertain', { options: SOT }, async ($, on) => {
    const w = make(on, { files: bridged(), rdtRejects: true })
    await start($, w)
    await engage($, w)
    await confirmViaPane($, w)
    expect(bridgeLog(w).map(l => l.kind)).toEqual(['intent', 'uncertain'])
    clean(w)
  })

  test('a malformed bridge log refuses the whole hand-off', { options: SOT }, async ($, on) => {
    const w = make(on, { files: bridged({ [`${STORE}/bridge-2026.ndjson`]: 'not json\n' }) })
    await start($, w)
    await engage($, w)
    await confirmViaPane($, w)
    expect(adds(w)).toEqual([])
    expect(w.toasts.at(-1)).toMatch(/nothing handed off: the bridge log has 1 line it cannot read/)
    clean(w)
  })

  test('corroborate never runs rdt add', { options: RDT }, async ($, on) => {
    const w = make(on, { files: bridged() })
    await start($, w)
    await engage($, w)
    await confirmViaPane($, w)
    expect(review(w).revisions).toHaveLength(1)
    expect(adds(w)).toEqual([])
    expect(w.files.has(`${STORE}/bridge-2026.ndjson`)).toBe(false)
    clean(w)
  })
})

describe('refresh and the options', () => {
  test('presses during a refresh join it', async ($, on) => {
    const w = make(on)
    await start($, w)
    const ui = await pane($)
    const before = rollupCount(w)
    await Promise.all([ui.press({ key: 'refresh' }), ui.press({ key: 'refresh' }), ui.press({ key: 'refresh' })])
    await w.clock.settle()
    expect(rollupCount(w) - before).toBe(1)
    await ui.unmount()
    clean(w)
  })

  test('arming is idempotent across a second session.start', async ($, on) => {
    const w = make(on)
    await start($, w)
    await start($, w)
    const before = rollupCount(w)
    await w.clock.advance(5 * 60_000)
    expect(rollupCount(w) - before).toBe(1)
    clean(w)
  })

  test('refreshMinutes 1 refreshes every minute', { options: { refreshMinutes: 1 } }, async ($, on) => {
    const w = make(on)
    await start($, w)
    const before = rollupCount(w)
    await w.clock.advance(10 * 60_000)
    expect(rollupCount(w) - before).toBe(10)
    clean(w)
  })

  test('refreshMinutes 60 does not refresh within ten minutes', { options: { refreshMinutes: 60 } }, async ($, on) => {
    const w = make(on)
    await start($, w)
    const before = rollupCount(w)
    await w.clock.advance(10 * 60_000)
    expect(rollupCount(w) - before).toBe(0)
    clean(w)
  })

  test('idleGapMinutes 5 splits the three prompts and changes the method hash', { options: { idleGapMinutes: 5 } }, async ($, on) => {
    const w = make(on, { files: withMapping(MAPPED) })
    await start($, w)
    await engage($, w)
    const r = lastRollup(w) as { method: string; weekTotalS: number }
    expect(r.method).not.toBe('union-v2/a5db146c')
    expect(r.method).toMatch(/^union-v2\/[0-9a-f]{8}$/)
    expect(r.weekTotalS).toBe(180)
    clean(w)
  })

  test('the default gap merges them into one 1200 s block under the golden method', async ($, on) => {
    const w = make(on, { files: withMapping(MAPPED) })
    await start($, w)
    await engage($, w)
    const r = lastRollup(w) as { method: string; weekTotalS: number }
    expect(r.method).toBe('union-v2/a5db146c')
    expect(r.weekTotalS).toBe(1200)
    clean(w)
  })

  for (const ttl of ['5m', '1h'] as const) {
    test(`cacheTtl ${ttl} prices the cache write at its multiplier`, { options: { cacheTtl: ttl } }, async ($, on) => {
      const w = make(on, { files: withMapping(MAPPED) })
      await start($, w)
      await turn($, 't-1')
      await w.clock.advance(500)
      await engage($, w)
      const r = lastRollup(w) as { spendMonthUsd: number }
      const t = { seq: 1, ts: T0 - 2000, endTs: T0, turnId: 't-1', agentKey: '', agent: 0 as const, model: 'claude-opus-5-5', in: 1000, out: 500, cr: 2000, cw: 400, reason: 'answer' as const }
      const other = ttl === '5m' ? '1h' : '5m'
      expect(Math.abs(r.spendMonthUsd - (priceTurn(t, ttl).usd as number))).toBeLessThan(1e-9)
      expect(Math.abs(r.spendMonthUsd - (priceTurn(t, other).usd as number))).toBeGreaterThan(1e-6)
      clean(w)
    })
  }

  test('temp files older than an hour are swept one rm -f each; a fresh one is kept', async ($, on) => {
    const dir = `${STORE}/sessions/2026/10`
    const stale = `${dir}/${SID2}.abc.json.tmp.abc.3`
    const w = make(on, { files: files({ [stale]: '{' }) })
    await start($, w)
    expect(w.files.has(stale)).toBe(true)
    await w.clock.advance(2 * 60 * 60_000)
    expect(w.files.has(stale)).toBe(false)
    expect(w.argv.filter(a => a[0] === '/bin/rm')).toEqual([['/bin/rm', '-f', stale]])
    clean(w)
  })

  test('a symbolic-link store is never written through, and the pane says so', async ($, on) => {
    const w = make(on, { links: [STORE] })
    await start($, w)
    await submit($)
    expect(segments(w)).toEqual([])
    expect(w.argv.filter(a => a[0] === '/bin/mv')).toEqual([])
    const ui = await pane($)
    expect(await ui.find({ type: 'Text', text: /symbolic link/ })).toBeDefined()
    await ui.unmount()
    clean(w)
  })

  test('a linked month folder is never written through (verifier V4): the write is refused and reported', async ($, on) => {
    const w = make(on, { links: [`${STORE}/sessions/2026/10`] })
    await start($, w)
    await submit($, { kind: 'composer' })
    await w.clock.settle()
    expect([...w.files.keys()].filter(p => p.startsWith(`${STORE}/sessions/2026/10/`))).toEqual([])
    expect(w.argv.some(a => a[0] === '/bin/mv' && String(a[a.length - 1]).startsWith(`${STORE}/sessions/2026/10/`))).toBe(false)
  })
})

// The second test reseeds a fresh world with the first one's files: the decisions live in files, not in state.
let carried: { files: Record<string, string>; weekRows: unknown; queue: unknown; reviews: unknown } | null = null

describe('decisions round-trip through the files', () => {
  test('map, note, POE and Confirm in one world', async ($, on) => {
    const w = make(on, { files: withMapping(MAPPING) })
    await start($, w)
    await engage($, w)
    const ui = await pane($)
    await ui.press({ key: 'view-review' })
    await ui.select({ key: `map:shop#${HASH}`, value: 'c:acme-app' })
    await w.clock.settle()
    await ui.input({ key: 'note:acme-app', text: 'Measured three retry policies against the flaky checkout API.' })
    await ui.press({ key: `poe:${ROW}` })
    await ui.press({ key: 'confirm' })
    await w.clock.settle()
    await ui.unmount()
    const r = lastRollup(w) as { weekRows: unknown; queue: unknown; reviews: unknown }
    expect((r.weekRows as { status: string }[])[0]?.status).toBe('confirmed')
    carried = { files: Object.fromEntries([...w.files.entries()].map(([p, f]) => [p, f.text])), weekRows: r.weekRows, queue: r.queue, reviews: r.reviews }
    clean(w)
  })

  test('a fresh world from those files shows the same rows, queue and review', async ($, on) => {
    expect(carried).not.toBeNull()
    const c = carried as NonNullable<typeof carried>
    const w = make(on, { files: c.files })
    await w.clock.set(T0 + 1_800_000)
    await start($, w)
    await rd($, '', { kind: 'peer' })
    const r = lastRollup(w) as { weekRows: unknown; queue: unknown; reviews: unknown }
    expect(r.weekRows).toEqual(c.weekRows)
    expect(r.queue).toEqual(c.queue)
    expect(r.reviews).toEqual(c.reviews)
    clean(w)
  })
})

// --- verifier round two: regressions pinned (N1, N5, V6, V9, V10) ------------------------------

describe('verifier round two', () => {
  test('N1: a changed amount for a destination already sent is recorded as needs-manual-adjust even when nothing new is sent', { options: SOT }, async ($, on) => {
    const w = make(on, { files: bridged() })
    await start($, w)
    await engage($, w)
    await confirmViaPane($, w)
    expect(bridgeLog(w).map(l => l.kind)).toEqual(['intent', 'sent'])
    // More time on the same day, same destination: the amount changes, nothing new to send.
    await submit($)
    await w.clock.advance(600_000)
    await submit($)
    await w.clock.settle()
    await confirmViaPane($, w)
    expect(adds(w)).toHaveLength(1)
    const kinds = bridgeLog(w).map(l => l.kind)
    expect(kinds).toEqual(['intent', 'sent', 'needs-manual-adjust'])
    expect(bridgeLog(w)[2]).toMatchObject({ date: '2026-10-11', rdtEntity: 'acme', rdtComponent: 'acme-app' })
    expect(w.toasts.at(-1)).toMatch(/nothing new to hand off; 1 need a manual adjustment/)
    // A third Confirm with the same amount writes no second adjust line.
    await confirmViaPane($, w)
    expect(bridgeLog(w)).toHaveLength(3)
    clean(w)
  })

  test('V10: a stale lock is never taken over by the code; Data health shows it and the person clears it with a confirmed button', async ($, on) => {
    const w = make(on, { files: withMapping(MAPPING), dirs: [`${STORE}/.lock`], dirMtimes: { [`${STORE}/.lock`]: T0 - 20 * 60_000 } })
    await start($, w)
    await engage($, w)
    const ui = await pane($)
    expect((lastRollup(w)?.['health'] as { lockStaleMs: number | null }).lockStaleMs ?? 0).toBeGreaterThanOrEqual(20 * 60_000)
    await ui.press({ key: 'view-review' })
    await ui.select({ key: `map:shop#${HASH}`, value: 'c:acme-app' })
    await w.clock.settle()
    // The save waited: no takeover (no mv or rmdir of the lock), nothing written.
    expect(w.argv.some(a => (a[0] === '/bin/mv' || a[0] === '/bin/rmdir') && String(a[a.length - 1]).includes('.lock'))).toBe(false)
    expect(JSON.parse(w.files.get(`${STORE}/components.json`)?.text ?? '{}').gen).toBe(MAPPING.gen)
    expect(w.toasts.at(-1)).toMatch(/crashed session \d+ minutes ago/)
    await ui.press({ key: 'view-overview' })
    expect(await ui.find({ type: 'Button', text: /Clear stale lock/ })).toBeDefined()
    await ui.press({ key: 'clear-lock' })
    await w.clock.settle()
    expect(w.asked.at(-1)).toMatch(/Clear the store lock left by another session \d+ minutes ago/)
    expect(w.dirs.has(`${STORE}/.lock`)).toBe(false)
    expect(w.argv.filter(a => a[0] === '/bin/rmdir' && a[1] === `${STORE}/.lock`)).toHaveLength(1)
    await ui.unmount()
    clean(w)
  })

  test('N5: a month folder that does not exist yet under a linked year folder is never written through', async ($, on) => {
    const w = make(on, { links: [`${STORE}/sessions/2026`] })
    await start($, w)
    await submit($, { kind: 'composer' })
    await w.clock.settle()
    expect([...w.files.keys()].filter(p => p.startsWith(`${STORE}/sessions/2026/`))).toEqual([])
    expect(w.argv.some(a => a[0] === '/bin/mv' && String(a[a.length - 1]).startsWith(`${STORE}/sessions/2026/`))).toBe(false)
  })

  test('V9: the sentinel also stays out of the bridge log and the hand-off argv when the bridge is configured', { options: SOT }, async ($, on) => {
    const w = make(on, { files: bridged() })
    await start($, w)
    for (const origin of [{ kind: 'composer' }, { kind: 'sdk' }, { kind: 'peer' }]) {
      await submit($, origin, { text: SENTINEL, attachments: [{ kind: 'image', name: SENTINEL }], context: [SENTINEL] })
      await w.clock.advance(600_000)
    }
    await confirmViaPane($, w)
    expect(adds(w).length).toBeGreaterThan(0)
    expect(corpus(w)).not.toContain('SNTL-7f3a9c')
    expect(corpus(w)).not.toContain('e@x.test')
    expect(JSON.stringify(bridgeLog(w))).not.toContain('SNTL')
    clean(w)
  })

  test('V9: a mapping whose gen changed on disk since it was loaded is not saved over', async ($, on) => {
    const w = make(on, { files: withMapping(MAPPING) })
    await start($, w)
    await engage($, w)
    const ui = await pane($)
    await ui.press({ key: 'view-review' })
    // Another session saved meanwhile: the file's gen moved on.
    const path = `${STORE}/components.json`
    const onDisk = JSON.parse(w.files.get(path)?.text ?? '{}')
    const bumped = JSON.stringify({ ...onDisk, gen: onDisk.gen + 1 })
    w.files.set(path, { text: bumped, mtimeMs: w.clock.now(), size: bumped.length })
    await ui.select({ key: `map:shop#${HASH}`, value: 'c:acme-app' })
    await w.clock.settle()
    const saved = JSON.parse(w.files.get(path)?.text ?? '{}')
    expect(saved.gen).toBe(onDisk.gen + 1)
    expect(saved.repos?.[`shop#${HASH}`]).toBeUndefined()
    expect(w.toasts.some(t => /changed on disk|reopen Review|gen/i.test(t))).toBe(true)
    await ui.unmount()
    clean(w)
  })

  test('V6: a segment file over 4 MiB is counted unreadable, never rewritten', async ($, on) => {
    const big = `${STORE}/sessions/2026/10/${SID2}.m2x.json`
    const w = make(on, { files: withMapping(MAPPING) })
    w.files.set(big, { text: '{', mtimeMs: T0 - 1000, size: FOUR_MIB + 1 })
    await start($, w)
    await engage($, w)
    expect(lastRollup(w)?.['health']).toMatchObject({ unreadable: 1 })
    expect(w.files.get(big)?.size).toBe(FOUR_MIB + 1)
    expect(w.argv.some(a => a[0] === '/bin/mv' && a[a.length - 1] === big)).toBe(false)
    clean(w)
  })
})

describe('verifier round three', () => {
  test('V12: a hand-off question left open for ten minutes still sends; the time guard counts the hold only', { options: SOT }, async ($, on) => {
    // The person answers the question after 11 minutes: a hook registered before the world's answerer sits above it, moves the clock, then hands on.
    let w: World | null = null
    on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e, next) => {
      await w?.clock.advance(11 * 60_000)
      return next(e)
    })
    w = make(on, { files: bridged() })
    await start($, w)
    await engage($, w)
    await confirmViaPane($, w)
    expect(adds(w)).toHaveLength(1)
    expect(bridgeLog(w).map(l => l.kind)).toEqual(['intent', 'sent'])
    clean(w)
  })

  test('V14: a stale lock cleared and re-taken by others while the question is open is never removed', async ($, on) => {
    let w: World | null = null
    let swapped = false
    on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e, next) => {
      // Meanwhile: someone cleared the stale lock and another session took a fresh one (its age unknown to the world).
      if (w) {
        w.dirs.delete(`${STORE}/.lock`)
        delete w.dirMtimes[`${STORE}/.lock`]
        w.dirs.add(`${STORE}/.lock`)
        swapped = true
      }
      return next(e)
    })
    w = make(on, { files: withMapping(MAPPING), dirs: [`${STORE}/.lock`], dirMtimes: { [`${STORE}/.lock`]: T0 - 20 * 60_000 } })
    await start($, w)
    await engage($, w)
    const ui = await pane($)
    await ui.press({ key: 'clear-lock' })
    await w.clock.settle()
    expect(w.asked.at(-1)).toMatch(/Clear the store lock/)
    expect(swapped).toBe(true)
    expect(w.dirs.has(`${STORE}/.lock`)).toBe(true)
    expect(w.argv.filter(a => a[0] === '/bin/rmdir' && a[1] === `${STORE}/.lock`)).toHaveLength(0)
    expect(w.toasts.at(-1)).toMatch(/the lock changed while the question was open/)
    await ui.unmount()
    clean(w)
  })
})

describe('live check 2026-10-12', () => {
  test('the desktop attaches its surface after session.start: the first prompt learns it, the record carries it, and export may act', async ($, on) => {
    const w = make(on, { files: withMapping(MAPPING), surfaces: ['desktop'] })
    // session.start on the desktop reports no surface and not interactive (observed live).
    await $.session.start({ cwd: `${HOME}/shop`, surface: null, isInteractive: false })
    await w.clock.settle()
    await submit($, { kind: 'sdk' })
    await w.clock.settle()
    const rec = record(w, segments(w)[0] as string)
    expect(rec.surface).toBe('desktop')
    expect(rec.events.map((e: { reason: string }) => e.reason)).toEqual(['human-desktop-host'])
    const r = await $.command.run({ command: 'rd', args: 'export', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    expect(r.text.includes('runs only from your own prompt')).toBe(false)
    clean(w)
  })
})

// --- the Session and Sessions views (SPEC §6.1a, §6.1b) -------------------------------------

/** Shares SID's first eight characters, so `/rd session 11111111` is ambiguous. */
const TWIN = '11111111-bbbb-4bbb-8ccc-000000000009'
/** Another session's segment file, already on disk, in October 2026. */
const segmentFile = (sessionId: string, openedAt: number): Record<string, string> => {
  const r = newSegment({ sessionId, openedAt, source: 'startup', entrypoint: 'cli', interactive: true, surface: 'cli', repoKey: 'other-repo', repoKind: 'repo', rootHash: null, cwdBase: 'other-repo', branch: null, model: 'claude-opus-5-5', engineCostAtOpen: null })
  return { [`${STORE}/sessions/2026/10/${sessionId}.${r.seg}.json`]: encodeSession(r) }
}

describe('the Session and Sessions views', () => {
  test('/rd session, /rd sessions and /rd session <id8> open the views; an unknown, shared or malformed prefix opens nothing', async ($, on) => {
    const w = make(on, { files: withMapping(MAPPED, { ...segmentFile(SID2, T0 - 3_600_000), ...segmentFile(TWIN, T0 - 7_200_000) }) })
    await start($, w)
    await engage($, w)
    expect((await rd($, 'session')).text).toBe('R&D ledger pane opened.')
    let ui = await pane($)
    expect(await ui.find({ type: 'Text', text: /^Session 11111111 · opened 2026-10-11 09:00 · repo shop · / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Engaged 0\.33 h · 3 prompts/ })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    await ui.unmount()
    expect((await rd($, 'sessions')).text).toBe('R&D ledger pane opened.')
    ui = await pane($)
    expect(await ui.find({ type: 'Text', text: /^Sessions this and last month · 3 sessions/ })).toBeDefined()
    await ui.unmount()
    expect((await rd($, 'session 22222222')).text).toBe('R&D ledger pane opened.')
    ui = await pane($)
    expect(await ui.find({ type: 'Text', text: /^Session 22222222 · .* · repo other-repo · / })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: /^Sessions this and last month/ })).toBeDefined()
    await ui.unmount()
    const opened = w.opened.length
    expect((await rd($, 'session 11111111')).text).toBe(`R&D ledger: 2 sessions start with 11111111 (${SID}, ${TWIN}); nothing opened.`)
    expect((await rd($, 'session 99999999')).text).toBe('R&D ledger: none of the newest 300 sessions this or last month starts with 99999999; nothing opened.')
    expect((await rd($, 'session 1111')).text).toBe(USAGE)
    expect((await rd($, 'session 22222222 extra')).text).toBe(USAGE)
    expect(w.opened).toHaveLength(opened)
    // Anyone else gets the one summary line, never a view or a session id.
    expect((await rd($, 'session 22222222', { kind: 'peer' })).text).toMatch(/^R&D: /)
    expect((await rd($, 'sessions', { kind: 'task-notification' })).text).toMatch(/^R&D: /)
    expect(w.opened).toHaveLength(opened)
    clean(w)
  })

  test('the Sessions picker opens a session and Session returns to this one; mobile lists the rows with the command instead', async ($, on) => {
    const w = make(on, { files: withMapping(MAPPED, segmentFile(SID2, T0 - 3_600_000)) })
    await start($, w)
    await engage($, w)
    const ui = await pane($)
    await ui.press({ key: 'view-sessions' })
    await ui.select({ key: 'open-session', value: SID2 })
    await w.clock.settle()
    expect(await ui.find({ type: 'Text', text: /^Session 22222222/ })).toBeDefined()
    await ui.press({ key: 'view-session' })
    await w.clock.settle()
    expect(await ui.find({ type: 'Text', text: /^Session 11111111/ })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    await ui.unmount()
    const phone = await pane($, 'mobile')
    await phone.press({ key: 'view-sessions' })
    expect(JSON.stringify(await phone.drawn())).not.toContain('"Select"')
    expect(await phone.find({ type: 'Text', text: /open one with \/rd session <id8>/ })).toBeDefined()
    await phone.unmount()
    clean(w)
  })

  test('headless, the person gets the views as text without repository names', async ($, on) => {
    const w = make(on, { isHeadless: true, files: withMapping(MAPPED, segmentFile(SID2, T0 - 3_600_000)) })
    await start($, w)
    await engage($, w)
    const list = (await rd($, 'sessions')).text ?? ''
    expect(list.startsWith('Sessions this and last month · 2 sessions')).toBe(true)
    const one = (await rd($, 'session 22222222')).text ?? ''
    expect(one.startsWith('Session 22222222 · opened ')).toBe(true)
    for (const text of [list, one, (await rd($, 'session')).text ?? '']) {
      expect(text).not.toContain('other-repo')
      expect(text).not.toContain('shop')
    }
    expect(w.opened).toEqual([])
    clean(w)
  })
})

// The second test registers afresh over the first one's state: the view and the selected session persist.
let carriedView: { view: unknown; selected: unknown; files: Record<string, string> } | null = null

describe('the view persists across a fresh register', () => {
  test('opening a session writes the view and the selected session to state', async ($, on) => {
    let view: unknown
    let selected: unknown
    on('state.set', { plugin: 'rd-ledger', key: 'view' }, (_$, e, next) => {
      view = e.value
      return next(e)
    })
    on('state.set', { plugin: 'rd-ledger', key: 'selectedSession' }, (_$, e, next) => {
      selected = e.value
      return next(e)
    })
    const w = make(on, { files: withMapping(MAPPED, segmentFile(SID2, T0 - 3_600_000)) })
    await start($, w)
    await rd($, 'session 22222222')
    expect(view).toBe('session')
    expect(selected).toBe(SID2)
    carriedView = { view, selected, files: Object.fromEntries([...w.files.entries()].map(([p, f]) => [p, f.text])) }
    clean(w)
  })

  test('a fresh register over that state draws the same session', async ($, on) => {
    expect(carriedView).not.toBeNull()
    const c = carriedView as NonNullable<typeof carriedView>
    // Beneath the plugin, the state a reload keeps: the two values the first test wrote.
    on('state.get', { plugin: 'rd-ledger', key: 'view' }, () => ({ value: { value: c.view as 'session', version: 1 } }) as never)
    on('state.get', { plugin: 'rd-ledger', key: 'selectedSession' }, () => ({ value: { value: c.selected as string, version: 1 } }) as never)
    const w = make(on, { files: c.files })
    await start($, w)
    const ui = await pane($)
    expect(await ui.find({ type: 'Text', text: /^Session 22222222/ })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await ui.unmount()
    clean(w)
  })
})

describe('paging, details on demand and an older rollup', () => {
  /** 44 more sessions, one an hour back from T0, ids 30000000-…; the oldest four fall past the newest 40 rows. */
  const many = (): Record<string, string> => Object.assign({}, ...Array.from({ length: 44 }, (_, i) => segmentFile(`${(0x30000000 + i).toString(16)}-aaaa-4bbb-8ccc-000000000003`, T0 - (i + 1) * 3_600_000)))

  test('More lists 40 more rows and is persisted; a row past the newest 40 is summarized on demand', async ($, on) => {
    const w = make(on, { files: withMapping(MAPPED, many()) })
    await start($, w)
    await engage($, w)
    const ui = await pane($)
    await ui.press({ key: 'view-sessions' })
    expect(await ui.find({ type: 'Text', text: /^ {2}5 more — press More or \/rd session <id8>$/ })).toBeDefined()
    const oldest = '3000002b-aaaa-4bbb-8ccc-000000000003'
    expect((lastRollup(w)?.['details'] as Record<string, unknown>)[oldest]).toBeUndefined()
    await ui.press({ key: 'more' })
    await w.clock.settle()
    expect(w.stateSets).toContain(80)
    expect(await ui.find({ type: 'Text', text: /^ {2}open one with \/rd session <id8>$/ })).toBeDefined()
    expect(await ui.find({ key: 'more' })).toBeUndefined()
    await ui.select({ key: 'open-session', value: oldest })
    await w.clock.settle()
    expect((lastRollup(w)?.['details'] as Record<string, unknown>)[oldest]).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Session 3000002b/ })).toBeDefined()
    await ui.unmount()
    clean(w)
  })

  test('/rd session <id8> past the newest 40 refreshes until its summary lands, headless too', async ($, on) => {
    const w = make(on, { isHeadless: true, files: withMapping(MAPPED, many()) })
    await start($, w)
    await engage($, w)
    expect(((await rd($, 'session 3000002b')).text ?? '').startsWith('Session 3000002b · opened ')).toBe(true)
    clean(w)
  })

  test('a selection that dropped out of the newest 300 says so', async ($, on) => {
    on('state.get', { plugin: 'rd-ledger', key: 'view' }, () => ({ value: { value: 'session' as const, version: 1 } }) as never)
    on('state.get', { plugin: 'rd-ledger', key: 'selectedSession' }, () => ({ value: { value: '99999999-aaaa-4bbb-8ccc-000000000009', version: 1 } }) as never)
    const w = make(on)
    await start($, w)
    const ui = await pane($)
    expect(await ui.find({ type: 'Text', text: 'That session is no longer among the newest 300 this or last month.' })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await ui.unmount()
    clean(w)
  })

  test('a rollup written by older code, without the session fields, draws Reading the ledger and the chip from its own today figure, never a crash', async ($, on) => {
    const seen = recordTodayS(on)
    // The read answers { value: { value: { shape, value: rollup }, version } }: strip the session fields from the rollup inside.
    on('state.get', { plugin: 'rd-ledger', key: 'rollup' }, (_$, e, next) =>
      next(e).then(r => {
        const read = (r as { value?: { value?: unknown; version: number } }).value
        const shaped = read?.value
        if (!read || typeof shaped !== 'object' || shaped === null || !('shape' in shaped)) return r
        return { value: { ...read, value: { ...shaped, value: withoutSessions((shaped as { value: unknown }).value) } } }
      }) as never,
    )
    on('state.get', { plugin: 'rd-ledger', key: 'view' }, () => ({ value: { value: 'sessions' as const, version: 1 } }) as never)
    const w = make(on)
    await start($, w)
    const ui = await pane($)
    expect(await ui.find({ type: 'Text', text: 'Reading the ledger…' })).toBeDefined()
    await ui.unmount()
    const mode = await $.ui.mount({ plugin: 'rd-ledger', surface: 'desktop', ...MODE })
    // todayS has been in the rollup since v1, so an older build's rollup still gives today's hours exactly.
    expect((await mode.find({ key: 'rd-ledger' }))?.props['label']).toBe(footerLabel(seen.todayS))
    await mode.unmount()
    clean(w)
  })
})

/** Records the `todayS` of the last rollup the plugin read from state (null when none existed); register before make(on). */
function recordTodayS(on: Parameters<typeof make>[0]): { todayS: number | null } {
  const seen: { todayS: number | null } = { todayS: null }
  on('state.get', { plugin: 'rd-ledger', key: 'rollup' }, (_$, e, next) =>
    next(e).then(r => {
      const read = (r as { value?: { value?: unknown } }).value
      const shaped = read?.value
      const rollup = typeof shaped === 'object' && shaped !== null && 'shape' in shaped ? (shaped as { value: unknown }).value : shaped
      const t = typeof rollup === 'object' && rollup !== null ? (rollup as { todayS?: unknown }).todayS : undefined
      seen.todayS = typeof t === 'number' ? t : null
      return r
    }) as never,
  )
  return seen
}

/** A rollup with the session fields removed, as an older build's lacked them. */
function withoutSessions(rollup: unknown): unknown {
  if (typeof rollup !== 'object' || rollup === null) return rollup
  const { sessions: _s, details: _d, thisSessionId: _t, medianUsdPerHour: _m, engineUsd: _e, ...old } = rollup as Record<string, unknown>
  return old
}
