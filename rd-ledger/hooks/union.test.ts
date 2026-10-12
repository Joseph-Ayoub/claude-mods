import { describe, expect, test } from 'claude-code/testing'

import type { Block, EngagementEvent, Mapping, SessionRecord, UnionEvent } from '../types'
import { D1, F1_DAY_TOTALS, F1_EVENTS, F1_EXPECTED_ALLOCATIONS, F1_EXPECTED_BLOCKS, F1_EXPECTED_FLAGS, F1_REPOS, F1_UNION_EVENTS, F2_EVENTS, F2_EXPECTED_TOTAL, F3_DAY_LENGTH_MS, F3_DAY_TOTALS, F3_EVENTS, F4_DAY_LENGTH_MS, F4_DAY_TOTALS, F4_EVENTS, F4_EXPECTED_BLOCK_SECONDS, PARAMS, S1, S2, S3, SEG, ZONE } from './fixtures/ground-truth'
import { emptyMapping } from './mapping'
import { admitEvent, DEFAULT_PARAMS, newSegment } from './store'
import { dayBounds } from './tz'
import { allocate, apportion, buildBlocks, flags, methodString, segmentKey } from './union'

/** The F1 mapping, built by hand (loadMapping is W2's): alpha → comp-alpha, beta → comp-beta, both entity acme; gamma unmapped. */
const f1Mapping = (): Mapping => {
  const m = emptyMapping()
  m.gen = 1
  m.entities['acme'] = { name: 'Example Co', filing: 'c-corp' }
  m.components['comp-alpha'] = { name: 'Alpha', entity: 'acme', activity: 'direct_research', poe: true, rdt: 'comp-alpha' }
  m.components['comp-beta'] = { name: 'Beta', entity: 'acme', activity: 'direct_support', poe: false, rdt: null }
  m.repos['alpha'] = { component: 'comp-alpha' }
  m.repos['beta'] = { component: 'comp-beta' }
  return m
}

/** A segment with synthetic fields; events are given whole (admission already decided). */
const segment = (sessionId: string, repoKey: string | null, events: EngagementEvent[], extra: Partial<SessionRecord> = {}): SessionRecord => ({
  ...newSegment({ sessionId, openedAt: D1, source: 'startup', entrypoint: 'cli', interactive: true, surface: 'cli', repoKey, repoKind: 'repo', rootHash: null, cwdBase: repoKey ?? 'x', branch: 'main', model: 'claude-opus-5-5', engineCostAtOpen: null }),
  seg: SEG,
  events,
  ...extra,
})

/** F1's rows for one session as stored events (seq = position in F1_EVENTS, the denied ones included). */
const f1Rows = (sessionId: string): EngagementEvent[] =>
  F1_EVENTS.flatMap((x, i) => (x.sessionId === sessionId ? [{ seq: i + 1, ts: D1 + x.t * 1000, origin: x.origin, ...admitEvent(x.origin, x.id === 'X2' ? 'sdk-cli' : 'cli', 'cli'), queued: x.queued }] : []))

const f1Segments = (): Map<string, SessionRecord> =>
  new Map([S1, S2, S3].map(s => [segmentKey(s, SEG), segment(s, F1_REPOS[s] as string, f1Rows(s))] as const))

const idOf = (e: UnionEvent): string => (F1_EVENTS[e.seq - 1] as { id: string }).id
const shape = (b: Block) => ({ date: b.date, startT: (b.startTs - D1) / 1000, endT: (b.endTs - D1) / 1000, seconds: b.seconds, eventIds: b.events.map(idOf), flags: b.flags })
const total = (blocks: readonly Block[]): number => blocks.reduce((a, b) => a + b.seconds, 0)
const byDate = (blocks: readonly Block[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const b of blocks) out[b.date] = (out[b.date] ?? 0) + b.seconds
  return out
}
const at = (ms: number, sessionId = S1, seq = 1): UnionEvent => ({ ts: D1 + ms, sessionId, seg: SEG, seq })

describe('apportion and the method', () => {
  test('apportion sums exactly; largest remainder; ties to the earlier index (timeline.py 369-394)', async () => {
    expect(apportion(3300, [1, 1, 1, 1, 1])).toEqual([660, 660, 660, 660, 660])
    expect(apportion(1000, [1, 1, 1])).toEqual([334, 333, 333])
    expect(apportion(10, [1, 1, 1])).toEqual([4, 3, 3])
    expect(apportion(8400, [4, 2])).toEqual([5600, 2800])
    expect(apportion(5, [1, 2])).toEqual([2, 3])
    expect(apportion(7, [3, 1, 3])).toEqual([3, 1, 3])
    expect(apportion(0, [1, 1])).toEqual([0, 0])
    expect(apportion(60, [])).toEqual([])
    expect(() => apportion(10, [0, 0])).toThrow()
    for (let t = 0; t < 200; t += 7) for (const w of [[1], [1, 2], [3, 3, 3], [5, 1, 1, 2], [2, 7, 1, 1, 9]]) expect(apportion(t, w).reduce((a, b) => a + b, 0)).toBe(t)
  })

  test('method string: golden a5db146c; changes with the gap and with the zone', async () => {
    expect(methodString(DEFAULT_PARAMS, 'America/New_York')).toBe('union-v2/a5db146c')
    expect(methodString(PARAMS, ZONE)).toBe('union-v2/a5db146c')
    expect(methodString({ ...DEFAULT_PARAMS, gapS: 1801 }, ZONE)).not.toBe('union-v2/a5db146c')
    expect(methodString(DEFAULT_PARAMS, 'Asia/Kolkata')).not.toBe('union-v2/a5db146c')
    expect(methodString(DEFAULT_PARAMS, 'Asia/Kolkata')).toMatch(/^union-v2\/[0-9a-f]{8}$/)
  })
})

describe('ground truth', () => {
  test('F1: six blocks with dates, edges, seconds, events in order and flags', async () => {
    const blocks = buildBlocks(F1_UNION_EVENTS, PARAMS, ZONE)
    expect(blocks.map(shape)).toEqual(F1_EXPECTED_BLOCKS.map(b => ({ ...b })))
    expect(byDate(blocks)).toEqual({ ...F1_DAY_TOTALS })
  })

  test('F1: eleven allocations that sum per (date, session, component) to the hand arithmetic', async () => {
    const blocks = buildBlocks(F1_UNION_EVENTS, PARAMS, ZONE)
    const allocations = allocate(blocks, f1Segments(), f1Mapping())
    expect(allocations).toHaveLength(11)
    const sums = new Map<string, number>()
    for (const a of allocations) sums.set(`${a.date}|${a.sessionId}|${a.component}`, (sums.get(`${a.date}|${a.sessionId}|${a.component}`) ?? 0) + a.seconds)
    expect(Object.fromEntries(sums)).toEqual(Object.fromEntries(F1_EXPECTED_ALLOCATIONS.map(x => [`${x.date}|${x.sessionId}|${x.component}`, x.seconds])))
    for (const a of allocations) {
      expect(a.repoRef).toBe(F1_REPOS[a.sessionId] as string)
      expect(a.entity).toBe(a.component === '__unmapped__' ? '' : 'acme')
    }
    const perBlock = new Map<number, number>()
    for (const a of allocations) perBlock.set(a.blockStartTs, (perBlock.get(a.blockStartTs) ?? 0) + a.seconds)
    for (const b of blocks) expect(perBlock.get(b.startTs)).toBe(b.seconds)
  })

  test('F1 flags: the one over-cap chain dated by its first event, and nothing else (X1/X2 denied do not tip a day)', async () => {
    const blocks = buildBlocks(F1_UNION_EVENTS, PARAMS, ZONE)
    const out = flags(blocks, [...f1Segments().values()], PARAMS, ZONE)
    expect(out.map(f => ({ kind: f.kind, date: f.date }))).toEqual(F1_EXPECTED_FLAGS.map(f => ({ ...f })))
    expect(out[0]?.detail).toContain('15240 s')
  })

  test('F2: the midpoint tie rule cuts ten evenly spaced events in half (14400, not 14460)', async () => {
    const blocks = buildBlocks(F2_EVENTS, PARAMS, ZONE)
    expect(total(blocks)).toBe(F2_EXPECTED_TOTAL)
    expect(blocks.map(b => [b.seconds, b.events.length, b.flags])).toEqual([[7200, 5, ['over-4h']], [7200, 5, ['over-4h']]])
  })

  test('F3: spring-forward 2026-03-08 merges by elapsed time and splits at both midnights', async () => {
    const blocks = buildBlocks(F3_EVENTS, PARAMS, ZONE)
    expect(byDate(blocks)).toEqual({ ...F3_DAY_TOTALS })
    const { startTs, endTs } = dayBounds('2026-03-08', ZONE)
    expect(endTs - startTs).toBe(F3_DAY_LENGTH_MS)
  })

  test('F4: fall-back 2026-11-01 orders the repeated hour by real time', async () => {
    const blocks = buildBlocks(F4_EVENTS, PARAMS, ZONE)
    expect(blocks.map(b => b.seconds)).toEqual([...F4_EXPECTED_BLOCK_SECONDS])
    expect(byDate(blocks)).toEqual({ ...F4_DAY_TOTALS })
    const { startTs, endTs } = dayBounds('2026-11-01', ZONE)
    expect(endTs - startTs).toBe(F4_DAY_LENGTH_MS)
  })
})

describe('union rules', () => {
  test('gap boundary in milliseconds (rules 1 and 3): 1,799,999 and 1,800,000 merge, 1,800,001 splits, from any sub-second offset', async () => {
    for (const offset of [0, 999]) {
      for (const gap of [1_799_999, 1_800_000]) expect([offset, gap, buildBlocks([at(offset), at(offset + gap, S1, 2)], PARAMS, ZONE).length]).toEqual([offset, gap, 1])
      for (const gap of [1_800_001, 1_800_999]) expect([offset, gap, buildBlocks([at(offset), at(offset + gap, S1, 2)], PARAMS, ZONE).length]).toEqual([offset, gap, 2])
    }
    // A multi-event block's seconds are int() of its span in seconds, as rd-tracker does.
    expect(buildBlocks([at(0), at(1_799_999, S1, 2)], PARAMS, ZONE)[0]?.seconds).toBe(1799)
  })

  test('same-second events of one session both count (rule 2); two sessions at one second are two events with a zero span', async () => {
    const same = buildBlocks([at(0, S1, 1), at(400, S1, 2), at(999, S1, 3)], PARAMS, ZONE)
    expect(same.map(b => [b.events.length, b.seconds])).toEqual([[3, 0]])
    const two = buildBlocks([at(0, S1, 1), at(500, S2, 1)], PARAMS, ZONE)
    expect(two.map(b => [b.events.map(e => e.sessionId), b.seconds])).toEqual([[[S1, S2], 0]])
    // Input order never matters.
    const shuffled = buildBlocks([...F1_UNION_EVENTS].reverse(), PARAMS, ZONE)
    expect(shuffled.map(shape)).toEqual(F1_EXPECTED_BLOCKS.map(b => ({ ...b })))
  })

  test('the cap split recurses until every piece fits', async () => {
    const events = Array.from({ length: 20 }, (_, k) => at(k * 1_800_000 + 3_600_000, S1, k + 1))
    const blocks = buildBlocks(events, PARAMS, ZONE)
    expect(blocks.every(b => b.flags.includes('over-4h'))).toBe(true)
    expect(blocks.every(b => b.seconds <= PARAMS.maxBlockS)).toBe(true)
    expect(blocks.reduce((a, b) => a + b.events.length, 0)).toBe(20)
    const chainFlags = flags(blocks, [], PARAMS, ZONE).filter(f => f.kind === 'block-over-4h')
    expect(chainFlags).toHaveLength(1)
  })

  test('an event exactly on midnight closes the block on its end: no split, dated the earlier day', async () => {
    const midnight = dayBounds('2026-10-12', ZONE).startTs
    const blocks = buildBlocks([{ ts: midnight - 600_000, sessionId: S1, seg: SEG, seq: 1 }, { ts: midnight, sessionId: S1, seg: SEG, seq: 2 }], PARAMS, ZONE)
    expect(blocks.map(b => [b.date, b.seconds])).toEqual([['2026-10-11', 600]])
  })

  test('allocate: a missing segment or a segment without a repository lands in __unmapped__ with an empty repoRef; ignore and nonRd buckets', async () => {
    const m = f1Mapping()
    m.repos['scratch'] = { ignore: true }
    m.repos['house'] = { nonRd: true, entity: 'acme' }
    const segs = new Map<string, SessionRecord>([
      [segmentKey(S1, SEG), segment(S1, 'scratch', [])],
      [segmentKey(S2, SEG), segment(S2, 'house', [])],
      [segmentKey(S3, SEG), segment(S3, null, [])],
    ])
    const blocks = buildBlocks([at(0, S1, 1), at(60_000, S2, 1), at(120_000, S3, 1), at(180_000, '44444444-aaaa-4bbb-8ccc-000000000004', 1)], PARAMS, ZONE)
    const out = allocate(blocks, segs, m)
    expect(out.map(a => [a.component, a.entity, a.repoRef, a.seconds])).toEqual([
      ['__ignored__', '', 'scratch', 45],
      ['__non_rd__', 'acme', 'house', 45],
      ['__unmapped__', '', '', 45],
      ['__unmapped__', '', '', 45],
    ])
  })
})

describe('flags', () => {
  test('day-over-cap only when a day strictly exceeds the flag hours', async () => {
    const p = { ...PARAMS, dayFlagH: 1 }
    const exact = buildBlocks([at(0), at(1_800_000, S1, 2), at(3_600_000, S1, 3)], p, ZONE)
    expect(flags(exact, [], p, ZONE).filter(f => f.kind === 'day-over-cap')).toEqual([])
    const over = buildBlocks([at(0), at(1_800_000, S1, 2), at(3_600_000, S1, 3), at(3_601_000, S1, 4)], p, ZONE)
    expect(over.map(b => b.seconds)).toEqual([3601])
    expect(flags(over, [], p, ZONE).filter(f => f.kind === 'day-over-cap').map(f => f.date)).toEqual(['2026-10-11'])
  })

  test('automation-heavy: 10 denied to 1 admitted is not flagged, 11 to 1 is', async () => {
    const rows = (denied: number): EngagementEvent[] => [
      { seq: 1, ts: D1 + 3_600_000, origin: 'composer', admit: 1, reason: 'human', queued: 0 },
      ...Array.from({ length: denied }, (_, k) => ({ seq: k + 2, ts: D1 + 3_700_000 + k * 1000, origin: 'sdk', admit: 0 as const, reason: 'automation-entrypoint', queued: 0 as const })),
    ]
    expect(flags([], [segment(S1, 'alpha', rows(10))], PARAMS, ZONE)).toEqual([])
    expect(flags([], [segment(S1, 'alpha', rows(11))], PARAMS, ZONE).map(f => [f.kind, f.date])).toEqual([['automation-heavy', '2026-10-11']])
  })

  test('rows-dropped once per segment that dropped events, dated by its open date', async () => {
    const out = flags([], [segment(S1, 'alpha', [], { eventsDropped: 3, openedAt: D1 + 3_600_000 }), segment(S2, 'beta', [], { turnsDropped: 2 })], PARAMS, ZONE)
    expect(out.map(f => [f.kind, f.date])).toEqual([['rows-dropped', '2026-10-11']])
    expect(out[0]?.detail).toContain('3')
  })
})
