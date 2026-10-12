import { describe, expect, test } from 'claude-code/testing'

import type { ConfirmedRow, EngagementEvent, Mapping, ReviewFile, SessionRecord, TurnRecord } from '../types'
import { D1, F1_EVENTS, F1_REPOS, PARAMS, S1, S2, S3, SEG, ZONE } from './fixtures/ground-truth'
import { emptyMapping } from './mapping'
import { computeRollup, type RollupInput, scopeWeeks } from './rollup'
import { admitEvent, newSegment } from './store'

/** 2026-10-11 20:00 in New York (EDT): ISO week 2026-W41, today 10-11. */
const NOW = D1 + 20 * 3_600_000
const M = 1_000_000
const micro = (usd: number | null | undefined): number | null => (usd === null || usd === undefined ? null : Math.round(usd * 1e6))

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

const turn = (over: Partial<TurnRecord>): TurnRecord => ({ seq: 900, ts: D1 + 33_000_000, endTs: D1 + 33_010_000, turnId: 'turn-1', agentKey: '', agent: 0, model: 'claude-opus-5-5', in: 0, out: 0, cr: 0, cw: 0, reason: 'answer', ...over })

/**
 * F1 as stored segments: X2 came from an `sdk-cli` process, so it lives in a
 * second segment of S2 opened with that entrypoint; X1 is a task notification
 * in S3. Admission verdicts come from the store's own table.
 */
const f1Segments = (opts: { s3Hash?: string | null; s1Branch?: string } = {}): SessionRecord[] => {
  const make = (sessionId: string, seg: string, entrypoint: string, repoKey: string, ids: (id: string) => boolean, extra: Partial<SessionRecord> = {}): SessionRecord => {
    // The branch goes in through newSegment so the opening branch is its first change point, as a live segment has it.
    const base = newSegment({ sessionId, openedAt: D1 + 3_600_000, source: 'startup', entrypoint, interactive: true, surface: 'cli', repoKey, repoKind: 'repo', rootHash: null, cwdBase: repoKey, branch: extra.branch ?? 'main', model: 'claude-opus-5-5', engineCostAtOpen: null })
    const events: EngagementEvent[] = F1_EVENTS.flatMap((x, i) => (x.sessionId === sessionId && ids(x.id) ? [{ seq: i + 1, ts: D1 + x.t * 1000, origin: x.origin, ...admitEvent(x.origin, entrypoint, 'cli'), queued: x.queued }] : []))
    return { ...base, seg, events, ...extra }
  }
  return [
    make(S1, SEG, 'cli', F1_REPOS[S1] as string, () => true, { branch: opts.s1Branch ?? 'main', turns: [turn({ in: M })], engineCostAtOpen: 0, engineCostUsd: 1.5 }),
    make(S2, SEG, 'cli', F1_REPOS[S2] as string, id => id !== 'X2', { turns: [turn({ model: 'claude-sonnet-5', cw: M })] }),
    make(S2, 'segx', 'sdk-cli', F1_REPOS[S2] as string, id => id === 'X2'),
    make(S3, SEG, 'cli', F1_REPOS[S3] as string, () => true, { rootHash: opts.s3Hash ?? null, turns: [turn({ ts: Date.UTC(2026, 8, 20, 15), model: 'mystery-model', in: M })] }),
  ]
}

const input = (over: Partial<RollupInput> = {}): RollupInput => ({
  now: NOW,
  zone: ZONE,
  params: PARAMS,
  defaultTtl: '1h',
  segments: f1Segments(),
  mapping: f1Mapping(),
  reviews: new Map(),
  health: { zoneDetectedNow: ZONE, unreadable: 0, daysSinceExport: null, storeIsLink: false, bridge: 'off', readOnly: false },
  deadlines: [],
  ...over,
})

const row = (seconds: number, entity: string, activity: ConfirmedRow['activity'], poe: boolean): ConfirmedRow => ({ seconds, entity, activity, poe, source: 'confirmed' })
const confirmedW41 = (rows: Record<string, ConfirmedRow>): ReviewFile => ({
  v: 1,
  week: '2026-W41',
  revisions: [{ rev: 1, at: NOW, kind: 'confirm', confirmedAt: NOW, method: 'union-v2/a5db146c', params: PARAMS, zone: ZONE, mappingDigest: '', inputsDigest: '', rows, otherHours: {}, notes: {}, confirmedLagDays: 0 }],
})
const F1_W41_FROZEN = {
  'comp-alpha|2026-10-11': row(1980, 'acme', 'direct_research', true),
  'comp-beta|2026-10-11': row(6640, 'acme', 'direct_support', false),
  '__unmapped__|2026-10-11': row(5380, '', 'non_qualified', false),
}

describe('rollup over F1', () => {
  test('week, today, rows, queue, day totals, flags and health for the week of now', async () => {
    const r = computeRollup(input())
    expect([r.week, r.today, r.method, r.at, r.zone]).toEqual(['2026-W41', '2026-10-11', 'union-v2/a5db146c', NOW, ZONE])
    expect(r.todayS).toBe(14000)
    expect(r.dayTotals).toEqual({ '2026-10-05': 0, '2026-10-06': 0, '2026-10-07': 0, '2026-10-08': 0, '2026-10-09': 0, '2026-10-10': 0, '2026-10-11': 14000 })
    expect([r.weekTotalS, r.weekUnmappedS, r.weekIgnoredS]).toEqual([14000, 5380, 0])
    expect(r.weekRows.map(w => [w.key, w.seconds, w.entity, w.activity, w.poe, w.status, w.confirmedSeconds, w.flags])).toEqual([
      ['comp-alpha|2026-10-11', 1980, 'acme', 'direct_research', true, 'pretag', null, []],
      ['comp-beta|2026-10-11', 6640, 'acme', 'direct_support', false, 'pretag', null, ['over-4h']],
      ['__unmapped__|2026-10-11', 5380, '', 'non_qualified', false, 'pretag', null, ['over-4h']],
    ])
    expect(r.queue).toEqual([{ key: 'gamma', repoKey: 'gamma', rootHash: null, seconds: 5380, branches: ['main'], sessions: 1, isNewLocation: false }])
    expect(r.flags.map(f => [f.kind, f.date])).toEqual([['block-over-4h', '2026-10-11']])
    expect(r.reviews).toEqual([
      { week: '2026-W41', confirmed: false, rev: 0, changedRows: 0 },
      { week: '2026-W40', confirmed: false, rev: 0, changedRows: 0 },
    ])
    expect(r.health).toEqual({ zone: ZONE, zoneDetectedNow: ZONE, pricesAsOf: '2026-10-06', sessionsInScope: 3, segmentsInScope: 4, unreadable: 0, deniedByReason: { 'automation-entrypoint': 1, 'origin:task-notification': 1 }, redactions: 0, rowsDropped: 0, daysSinceExport: null, storeIsLink: false, bridge: 'off', readOnly: false })
  })

  test('the R&D view figures: gross spans, the weekly trend, by entity, component and class, flagged and longest days', async () => {
    const r = computeRollup(input())
    // 10-11 (W41): admitted events e1 (t 32400) .. e14 (t 85680) span 53280 s; net is the four blocks, 3300 + 60 + 5040 + 5600 = 14000.
    // 10-12 (W42, after now): e15 (87360) .. e19 (119800) span 32440 s; net 2800 + 1000 = 3800.
    expect([r.weekGrossS, r.todayGrossS, r.lastWeekTotalS]).toEqual([53280, 53280, 0])
    // Scope starts at the week holding 2026-09-01 (W36) and ends at this week; W42 is after now and not listed.
    expect(r.weekTrend).toEqual([
      { week: '2026-W41', netS: 14000, grossS: 53280, confirmed: false },
      { week: '2026-W40', netS: 0, grossS: 0, confirmed: false },
      { week: '2026-W39', netS: 0, grossS: 0, confirmed: null },
      { week: '2026-W38', netS: 0, grossS: 0, confirmed: null },
      { week: '2026-W37', netS: 0, grossS: 0, confirmed: null },
      { week: '2026-W36', netS: 0, grossS: 0, confirmed: null },
    ])
    // comp-alpha 1980 + comp-beta 6640 under acme; the unmapped bucket keeps its own row, so the rows add up to the week.
    expect(r.byEntity).toEqual([
      { entity: 'acme', seconds: 8620 },
      { entity: '__unmapped__', seconds: 5380 },
    ])
    expect(r.byComponent).toEqual([
      { component: 'comp-beta', entity: 'acme', activity: 'direct_support', seconds: 6640 },
      { component: '__unmapped__', entity: '', activity: null, seconds: 5380 },
      { component: 'comp-alpha', entity: 'acme', activity: 'direct_research', seconds: 1980 },
    ])
    expect(r.activityMix).toEqual([
      { activity: 'direct_research', seconds: 1980, poeS: 1980 },
      { activity: 'direct_support', seconds: 6640, poeS: 0 },
      { activity: 'non_qualified', seconds: 0, poeS: 0 },
      { activity: 'unclassified', seconds: 5380, poeS: 0 },
    ])
    expect(r.byEntity.reduce((s, e) => s + e.seconds, 0)).toBe(r.weekTotalS)
    expect(r.activityMix.reduce((s, a) => s + a.seconds, 0)).toBe(r.weekTotalS)
    expect(r.flaggedDays).toEqual([{ date: '2026-10-11', reason: 'block-over-4h', netS: 14000, grossS: 53280 }])
    expect(r.longestDays).toEqual([{ date: '2026-10-11', netS: 14000, grossS: 53280 }])
    expect(r.entityIds).toEqual(['acme'])
    // The next day: 10-11 becomes last week, W42 is this week with its one day.
    const next = computeRollup(input({ now: D1 + 86_400_000 + 12 * 3_600_000 }))
    expect([next.weekTotalS, next.weekGrossS, next.todayGrossS, next.lastWeekTotalS]).toEqual([3800, 32440, 32440, 14000])
    expect(next.weekTrend.slice(0, 2)).toEqual([
      { week: '2026-W42', netS: 3800, grossS: 32440, confirmed: false },
      { week: '2026-W41', netS: 14000, grossS: 53280, confirmed: false },
    ])
    // A confirmed W41 reads confirmed in the trend.
    expect(computeRollup(input({ reviews: new Map([['2026-W41', confirmedW41(F1_W41_FROZEN)]]) })).weekTrend[0]?.confirmed).toBe(true)
  })

  test('scopeWeeks: from the week of the first of last month to this week, across a year end', async () => {
    expect(scopeWeeks('2026-10-11')).toEqual(['2026-W36', '2026-W37', '2026-W38', '2026-W39', '2026-W40', '2026-W41'])
    expect(scopeWeeks('2027-01-04')).toEqual(['2026-W49', '2026-W50', '2026-W51', '2026-W52', '2026-W53', '2027-W01'])
    expect(scopeWeeks('2026-03-01')).toEqual(['2026-W05', '2026-W06', '2026-W07', '2026-W08', '2026-W09'])
  })

  test('spend for this and last month and the engine cost', async () => {
    const r = computeRollup(input())
    // opus-5-5 1M input = 4.00; sonnet-5 1M cache write under the 1h default = 2 x 2.0 = 4.00.
    expect(r.spendMonth.map(s => [s.month, s.model, s.component, s.entity, s.turns, micro(s.usd), s.priced])).toEqual([
      ['2026-10', 'claude-opus-5-5', 'comp-alpha', 'acme', 1, 4_000_000, true],
      ['2026-10', 'claude-sonnet-5', 'comp-beta', 'acme', 1, 4_000_000, true],
    ])
    expect(micro(r.spendMonthUsd)).toBe(8_000_000)
    expect(r.spendLastMonth.map(s => [s.month, s.model, s.component, s.entity, s.usd, s.priced])).toEqual([['2026-09', 'mystery-model', '__unmapped__', '', null, false]])
    expect(r.engineCost).toEqual({ usd: 1.5, segments: 1 })
  })

  test('a confirmed revision whose frozen rows match reads confirmed; a remap reads changed; a frozen row with no live time shows at zero', async () => {
    const confirmed = computeRollup(input({ reviews: new Map([['2026-W41', confirmedW41(F1_W41_FROZEN)]]) }))
    expect(confirmed.weekRows.map(w => [w.key, w.status, w.confirmedSeconds])).toEqual([
      ['comp-alpha|2026-10-11', 'confirmed', 1980],
      ['comp-beta|2026-10-11', 'confirmed', 6640],
      ['__unmapped__|2026-10-11', 'confirmed', 5380],
    ])
    expect(confirmed.reviews[0]).toEqual({ week: '2026-W41', confirmed: true, rev: 1, changedRows: 0 })

    const remapped = f1Mapping()
    remapped.repos['beta'] = { component: 'comp-alpha' }
    const changed = computeRollup(input({ mapping: remapped, reviews: new Map([['2026-W41', confirmedW41(F1_W41_FROZEN)]]) }))
    expect(changed.weekRows.map(w => [w.key, w.seconds, w.status, w.confirmedSeconds])).toEqual([
      ['comp-alpha|2026-10-11', 1980 + 6640, 'changed', 1980],
      ['comp-beta|2026-10-11', 0, 'changed', 6640],
      ['__unmapped__|2026-10-11', 5380, 'confirmed', 5380],
    ])
    expect(changed.reviews[0]).toEqual({ week: '2026-W41', confirmed: true, rev: 1, changedRows: 2 })
  })

  test('a new hash under a mapped bare key resolves through the bare key and still raises a new-location queue row', async () => {
    const m = f1Mapping()
    m.repos['gamma'] = { component: 'comp-alpha' }
    const r = computeRollup(input({ mapping: m, segments: f1Segments({ s3Hash: 'abcdef012345' }) }))
    expect(r.queue).toEqual([{ key: 'gamma#abcdef012345', repoKey: 'gamma', rootHash: 'abcdef012345', seconds: 5380, branches: ['main'], sessions: 1, isNewLocation: true }])
    expect(r.weekUnmappedS).toBe(0)
    expect(r.weekRows.map(w => [w.key, w.seconds])).toEqual([
      ['comp-alpha|2026-10-11', 1980 + 5380],
      ['comp-beta|2026-10-11', 6640],
    ])
  })

  test('a pre-tag rule on a branch seen that day sets the row activity; sentinel rows never take a pre-tag', async () => {
    const m = f1Mapping()
    m.pretag.push({ repo: 'alpha', branch: 'docs/*', activity: 'non_qualified', poe: false }, { repo: 'gamma', branch: null, activity: 'direct_research', poe: true })
    const r = computeRollup(input({ mapping: m, segments: f1Segments({ s1Branch: 'docs/readme' }) }))
    expect(r.weekRows.map(w => [w.key, w.activity, w.poe])).toEqual([
      ['comp-alpha|2026-10-11', 'non_qualified', false],
      ['comp-beta|2026-10-11', 'direct_support', false],
      ['__unmapped__|2026-10-11', 'non_qualified', false],
    ])
  })

  test('the next week: the 10-12 time is in W42 and the 10-11 time moves to last week', async () => {
    const r = computeRollup(input({ now: D1 + 86_400_000 + 12 * 3_600_000 }))
    expect([r.week, r.today, r.todayS, r.weekTotalS]).toEqual(['2026-W42', '2026-10-12', 3800, 3800])
    expect(r.reviews.map(x => x.week)).toEqual(['2026-W42', '2026-W41'])
    expect(r.queue.map(q => [q.key, q.seconds])).toEqual([['gamma', 1400]])
  })

  test('empty scope: zero totals, no rows, null engine cost, zero spend', async () => {
    const r = computeRollup(input({ segments: [] }))
    expect([r.weekGrossS, r.lastWeekTotalS, r.byEntity, r.byComponent, r.flaggedDays, r.longestDays]).toEqual([0, 0, [], [], [], []])
    expect(r.activityMix.every(a => a.seconds === 0 && a.poeS === 0)).toBe(true)
    expect([r.todayS, r.weekTotalS, r.weekRows.length, r.queue.length, r.flags.length, r.engineCost, r.spendMonthUsd]).toEqual([0, 0, 0, 0, 0, null, 0])
    expect(r.health.sessionsInScope).toBe(0)
  })
})

describe('sessions in the rollup', () => {
  test('thisSessionId and the engine figure follow the current session; every session in scope is a row with its details', async () => {
    const r = computeRollup(input({ current: { sessionId: S1, seg: SEG } }))
    expect(r.thisSessionId).toBe(S1)
    // S1's latest segment last read $1.50 from the engine: the footer and the Session view show the same figure.
    expect(r.engineUsd).toBe(1.5)
    expect(r.details[S1]?.engineUsd).toBe(1.5)
    expect(r.sessions.map(s => s.sessionId).sort()).toEqual([S1, S2, S3].sort())
    expect(Object.keys(r.details).sort()).toEqual([S1, S2, S3].sort())
    const none = computeRollup(input())
    expect(none.thisSessionId).toBeNull()
    expect(none.engineUsd).toBeNull()
  })

  test('details carry the newest 40, this session and the selected one only', async () => {
    const id = (i: number): string => `${(0x10000000 + i).toString(16)}-aaaa-4bbb-8ccc-000000000001`
    const many = Array.from({ length: 60 }, (_, i) =>
      newSegment({ sessionId: id(i), openedAt: D1 + i * 1000, source: 'startup', entrypoint: 'cli', interactive: true, surface: 'cli', repoKey: 'alpha', repoKind: 'repo', rootHash: null, cwdBase: 'alpha', branch: null, model: null, engineCostAtOpen: null }),
    )
    const r = computeRollup(input({ segments: many, current: { sessionId: id(0), seg: (many[0] as SessionRecord).seg }, selected: id(5) }))
    expect(r.sessions).toHaveLength(60)
    // Newest 40 are 59..20, plus this session (0) and the selected one (5).
    expect(Object.keys(r.details).sort()).toEqual([...Array.from({ length: 40 }, (_, i) => id(59 - i)), id(0), id(5)].sort())
    expect(computeRollup(input({ segments: many, selected: 'not-a-session' })).details['not-a-session']).toBeUndefined()
  })

  test('at most 300 sessions reach the view, the newest kept', async () => {
    const many = Array.from({ length: 305 }, (_, i) =>
      newSegment({ sessionId: `${(0x10000000 + i).toString(16)}-aaaa-4bbb-8ccc-000000000001`, openedAt: D1 + i * 1000, source: 'startup', entrypoint: 'cli', interactive: true, surface: 'cli', repoKey: 'alpha', repoKind: 'repo', rootHash: null, cwdBase: 'alpha', branch: null, model: null, engineCostAtOpen: null }),
    )
    const r = computeRollup(input({ segments: many }))
    expect(r.sessions).toHaveLength(300)
    expect(r.sessions[0]?.openedAt).toBe(D1 + 304_000)
    expect(r.sessions.at(-1)?.openedAt).toBe(D1 + 5000)
  })
})
