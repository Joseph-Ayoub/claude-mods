import { describe, expect, test } from 'claude-code/testing'

import type { Allocation, Block, Rollup, SessionRow, SessionSummary } from '../types'
import { D1, F1_EXPECTED_ALLOCATIONS, F1_EXPECTED_BLOCKS, F1_UNION_EVENTS, ZONE } from './fixtures/ground-truth'
import { dateOfDay, dayNumber, FOOTER_MAX, footerLabel, isoWeekOfDate, localClock, LOG_PAGE_LINES, monthBefore, monthlyLogPages, overviewText, sessionOptions, sessionsText, sessionText, spendText, summaryLine, textTable, TIME_MARK, utcIso, weekDateList } from './report'

const METHOD = 'union-v2/a5db146c'
const at = (t: number) => D1 + t * 1000

/** F1's six blocks, events filled from the union events by time. */
const f1Blocks = (): Block[] =>
  F1_EXPECTED_BLOCKS.map(b => ({
    date: b.date,
    startTs: at(b.startT),
    endTs: at(b.endT),
    seconds: b.seconds,
    events: F1_UNION_EVENTS.filter(e => e.ts >= at(b.startT) && e.ts <= at(b.endT)).slice(0, b.eventIds.length),
    flags: b.flags,
  }))
const f1Allocations = (): Allocation[] =>
  F1_EXPECTED_ALLOCATIONS.map(a => ({ date: a.date, blockStartTs: a.date === '2026-10-11' ? at(32400) : at(86400), sessionId: a.sessionId, seg: 'seg1', repoRef: 'x', component: a.component, entity: a.component === '__unmapped__' ? '' : 'acme', seconds: a.seconds }))

const rollup = (over: Partial<Rollup> = {}): Rollup => ({
  at: D1 + 120_000_000,
  zone: ZONE,
  method: METHOD,
  params: { gapS: 1800, floorS: 60, maxBlockS: 14_400, dayFlagH: 14 },
  week: '2026-W42',
  today: '2026-10-12',
  weekRows: [
    { key: 'comp-beta|2026-10-12', component: 'comp-beta', entity: 'acme', date: '2026-10-12', seconds: 1733, confirmedSeconds: null, activity: 'direct_support', poe: false, status: 'pretag', flags: [] },
    { key: 'comp-alpha|2026-10-12', component: 'comp-alpha', entity: 'acme', date: '2026-10-12', seconds: 667, confirmedSeconds: null, activity: 'direct_research', poe: true, status: 'pretag', flags: [] },
    { key: '__unmapped__|2026-10-12', component: '__unmapped__', entity: '', date: '2026-10-12', seconds: 1400, confirmedSeconds: null, activity: 'non_qualified', poe: false, status: 'pretag', flags: [] },
  ],
  weekTotalS: 3800,
  weekUnmappedS: 1400,
  weekIgnoredS: 0,
  todayS: 3800,
  queue: [{ key: 'secret-project#abcdef012345', repoKey: 'secret-project', rootHash: 'abcdef012345', seconds: 1400, branches: ['feat/hidden-name'], sessions: 1, isNewLocation: false }],
  spendMonth: [
    { month: '2026-10', model: 'claude-opus-5-5', component: 'comp-alpha', entity: 'acme', turns: 10, in: 1000, out: 2000, cr: 30_000, cw: 400, usd: 12.5, priced: true },
    { month: '2026-10', model: 'claude-sonnet-5-5', component: 'comp-beta', entity: 'acme', turns: 4, in: 100, out: 200, cr: 0, cw: 0, usd: 0.75, priced: true },
    { month: '2026-10', model: 'bad model\nname', component: '__unmapped__', entity: '', turns: 2, in: 5, out: 5, cr: 0, cw: 0, usd: null, priced: false },
  ],
  spendLastMonth: [],
  spendMonthUsd: 13.25,
  engineCost: { usd: 11.1, segments: 3 },
  deadlines: [{ date: '2027-04-15', label: 'Form 1120 (C-corp)', entity: 'acme' }],
  reviews: [
    { week: '2026-W42', confirmed: false, rev: 0, changedRows: 0 },
    { week: '2026-W41', confirmed: true, rev: 2, changedRows: 1 },
  ],
  flags: [{ kind: 'block-over-4h', date: '2026-10-11', detail: 'a detail with feat/hidden-name' }],
  health: { zone: ZONE, zoneDetectedNow: 'Europe/Paris', pricesAsOf: '2026-10-06', sessionsInScope: 3, segmentsInScope: 3, unreadable: 1, deniedByReason: { 'origin:task-notification': 1, 'automation-entrypoint': 1 }, redactions: 2, rowsDropped: 0, daysSinceExport: null, storeIsLink: true, bridge: 'corroborate', readOnly: false },
  dayTotals: { '2026-10-12': 3800 },
  sessions: [],
  details: {},
  thisSessionId: null,
  medianUsdPerHour: null,
  engineUsd: null,
  ...over,
})

describe('calendar helpers', () => {
  test('ISO weeks, week dates, months and UTC ISO without a Date', async () => {
    expect(isoWeekOfDate('2025-12-29')).toBe('2026-W01')
    expect(isoWeekOfDate('2027-01-01')).toBe('2026-W53')
    expect(isoWeekOfDate('2027-01-04')).toBe('2027-W01')
    expect(isoWeekOfDate('2026-10-11')).toBe('2026-W41')
    expect(isoWeekOfDate('2026-10-12')).toBe('2026-W42')
    expect(weekDateList('2026-W42')).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'])
    expect(weekDateList('2026-W01')[0]).toBe('2025-12-29')
    expect(dateOfDay(dayNumber('2024-02-29'))).toBe('2024-02-29')
    expect(monthBefore('2026-01')).toBe('2025-12')
    expect(monthBefore('2026-10')).toBe('2026-09')
    expect(utcIso(0)).toBe('1970-01-01T00:00:00.000Z')
    expect(utcIso(D1 + 1234)).toBe('2026-10-11T04:00:01.234Z')
  })
  test('local clock: offsets across both DST changes and a half-hour zone', async () => {
    const ny = localClock(ZONE)
    expect(ny.iso(D1)).toBe('2026-10-11T00:00:00-04:00')
    expect(ny.date(D1 - 1)).toBe('2026-10-10')
    expect(ny.hm(at(32400))).toBe('09:00')
    expect(ny.iso(Date.UTC(2026, 10, 1, 5, 10))).toBe('2026-11-01T01:10:00-04:00')
    expect(ny.iso(Date.UTC(2026, 10, 1, 6, 10))).toBe('2026-11-01T01:10:00-05:00')
    expect(ny.iso(Date.UTC(2026, 2, 8, 7, 10))).toBe('2026-03-08T03:10:00-04:00')
    expect(localClock('Asia/Kolkata').iso(D1)).toBe('2026-10-11T09:30:00+05:30')
    expect(localClock('UTC').iso(D1 + 999)).toBe('2026-10-11T04:00:00+00:00')
    expect(() => localClock('Nope/Zone')).toThrow()
  })
})

describe('text answers (CYB-13: counts, hours and validated ids only)', () => {
  test('overview: sections in order, buckets last, queue as a count, the estimate label', async () => {
    const text = overviewText(rollup(), 120)
    const order = ['This week  Oct 12 – Oct 18 · America/New_York · union-v2/a5db146c', 'Queue  1 repository unmapped (0.4 h)', 'Review  this week 2026-W42 open', 'Spend this month  $13.25 · list-price estimate, not an invoice', 'Deadlines (calendar tax year; verify with your CPA)', 'Data health', 'Commands']
    const positions = order.map(s => text.indexOf(s))
    expect(positions.every(p => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    const lines = text.split('\n')
    const idx = (prefix: string) => lines.findIndex(l => l.trimStart().startsWith(prefix))
    expect(idx('comp-alpha')).toBeLessThan(idx('comp-beta'))
    expect(idx('comp-beta')).toBeLessThan(idx('__unmapped__'))
    expect(idx('__unmapped__')).toBeLessThan(idx('__ignored__'))
    expect(idx('__ignored__')).toBeLessThan(idx('Total'))
    expect(lines[idx('__unmapped__')]).toContain('0.39 h')
    expect(lines[idx('Total')]).toContain('1.06 h')
    expect(text).toContain('last week 2026-W41 confirmed rev 2 (1 row changed since confirmation)')
    expect(text).toContain('claude-opus-5-5  $12.50')
    expect(text).toContain('(unrecognized model)')
    expect(text).toContain('engine /cost figure $11.10 over 3 segments')
    expect(text).toContain('2027-04-15  Form 1120 (C-corp)  acme')
    expect(text).toContain('Form 6765 Section G applies to tax years beginning after 2025 unless an exemption applies (R40, R41)')
    expect(text).toContain('zone America/New_York (this Mac now reads Europe/Paris)')
    expect(text).toContain('warning: the store is a symbolic link')
    expect(text).toContain('never exported')
    expect(text).toContain('automation-entrypoint 1 · origin:task-notification 1')
    // never a repo key, a branch, a flag's free text or a path
    for (const banned of ['secret-project', 'hidden-name', 'abcdef012345', '/Users/', 'a detail with']) expect(text).not.toContain(banned)
  })
  test('overview: every line fits the width, cut with an ellipsis', async () => {
    const text = overviewText(rollup(), 40)
    for (const line of text.split('\n')) expect([...line].length).toBeLessThanOrEqual(40)
    expect(text.split('\n').some(l => l.endsWith('…'))).toBe(true)
    expect(overviewText(rollup(), Number.NaN).split('\n').every(l => [...l].length <= 80)).toBe(true)
  })
  test('overview: hostile ids, zones and reasons are drawn as placeholders, never as lines', async () => {
    const hostile = rollup({
      zone: 'Evil\nZone',
      weekRows: [{ key: 'x', component: 'Bad Name\n__forged__ 99.00 h', entity: 'acme‮', date: '2026-10-12', seconds: 60, confirmedSeconds: null, activity: 'direct_research', poe: false, status: 'pretag', flags: [] }],
      health: { ...rollup().health, deniedByReason: { 'ghp_abcdefghijklmnopqrst\nrow': 3 } },
    })
    const text = overviewText(hostile, 200)
    expect(text).not.toContain('__forged__')
    expect(text).not.toContain('ghp_')
    expect(text).not.toContain('‮')
    expect(text).toContain('(unrecognized id)')
    expect(text).toContain('(unrecognized zone)')
    expect(text).toContain('(unrecognized reason) 3')
  })
  test('summary line', async () => {
    expect(summaryLine(rollup())).toBe('R&D: 1.06 h this week · 1.06 h today · 1 unmapped · week 2026-W42 open')
    expect(summaryLine(rollup({ reviews: [{ week: '2026-W42', confirmed: true, rev: 3, changedRows: 0 }] }))).toBe('R&D: 1.06 h this week · 1.06 h today · 1 unmapped · week 2026-W42 confirmed rev 3')
    expect(summaryLine(rollup({ week: 'W42\nx', weekTotalS: Number.NaN }))).toBe('R&D: 0.00 h this week · 1.06 h today · 1 unmapped · week (unrecognized week) open')
  })
  test('spend: by model and by component, labelled, both months', async () => {
    const text = spendText(rollup())
    expect(text.split('\n')[0]).toBe('Spend · list-price estimate, not an invoice · prices as of 2026-10-06')
    expect(text).toContain('This month 2026-10: $13.25 estimated')
    expect(text).toContain('claude-opus-5-5  10 turns  in 1000  out 2000  cache read 30000  cache write 400  $12.50')
    expect(text).toContain('(unrecognized model)  2 turns  in 5  out 5  cache read 0  cache write 0  $0.00 (2 turns unpriced)')
    expect(text).toContain('comp-alpha  acme  10 turns  $12.50')
    expect(text).toContain('__unmapped__  -  2 turns  $0.00')
    expect(text).toContain('engine /cost figure $11.10 over 3 segments')
    expect(text).toContain('Last month 2026-09: $0.00 estimated')
    expect(text).toContain("excludes the engine's side calls")
  })
})

describe('monthly log', () => {
  test('F1: per day blocks in local time, hours by component, one 66-line page', async () => {
    const text = monthlyLogPages('2026-10', f1Blocks(), f1Allocations(), ZONE, METHOD)
    const lines = text.split('\n')
    expect(lines.pop()).toBe('')
    expect(lines.length).toBe(LOG_PAGE_LINES)
    expect(lines[0]).toBe('rd-ledger monthly log 2026-10 · method union-v2/a5db146c · page 1 of 1')
    expect(lines.slice(2, 13)).toEqual([
      '2026-10-11 Sun',
      '  09:00–09:55  5 events  0.92 h',
      '  10:25–10:25  1 event  0.02 h',
      '  20:30–21:54  4 events  1.40 h  over-4h',
      '  22:24–00:00  4 events  1.56 h  over-4h',
      '  hours by component',
      '    comp-alpha  acme  0.55 h',
      '    comp-beta  acme  1.84 h',
      '    __unmapped__  -  1.49 h',
      '  day total 3.89 h',
      '',
    ])
    expect(lines[13]).toBe('2026-10-12 Mon')
    expect(text).toContain('  day total 1.06 h')
    expect(monthlyLogPages('2026-09', f1Blocks(), f1Allocations(), ZONE, METHOD)).toContain('No engagement recorded in 2026-09.')
  })
  test('pages of exactly 66 lines with page n of m and a continuation line', async () => {
    // 31 days × 3 blocks: about 8 lines a day, so several pages
    const blocks: Block[] = []
    for (let d = 0; d < 31; d++)
      for (let k = 0; k < 3; k++) {
        const start = Date.UTC(2026, 9, 1 + d, 14 + k * 2)
        blocks.push({ date: `2026-10-${String(d + 1).padStart(2, '0')}`, startTs: start, endTs: start + 600_000, seconds: 600, events: [{ ts: start, sessionId: 'a', seg: 's', seq: 1 }], flags: [] })
      }
    const text = monthlyLogPages('2026-10', blocks, [], ZONE, METHOD)
    const lines = text.split('\n')
    lines.pop()
    expect(lines.length % LOG_PAGE_LINES).toBe(0)
    const pages = lines.length / LOG_PAGE_LINES
    expect(pages).toBeGreaterThan(1)
    for (let p = 0; p < pages; p++) {
      const page = lines.slice(p * LOG_PAGE_LINES, (p + 1) * LOG_PAGE_LINES)
      expect(page.length).toBe(66)
      expect(page[0]).toBe(`rd-ledger monthly log 2026-10 · method union-v2/a5db146c · page ${p + 1} of ${pages}`)
      expect(page[1]).toBe('')
      if (p > 0) expect(page[2]).toMatch(/^2026-10-\d\d( \w{3}| \(continued\))$/)
    }
    expect(text).toContain('(continued)')
  })
})

// --- the footer, the Session and Sessions views (SPEC §6.1a, §6.1b, §6.5) ------------------

const SID_A = 'aaaaaaaa-1111-4111-8111-000000000001'
const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: SID_A,
  id8: 'aaaaaaaa',
  openedAt: D1 + 10 * 3_600_000,
  lastAt: D1 + 12 * 3_600_000,
  repoKey: 'secret-project',
  entrypoint: 'claude-desktop',
  segments: 2,
  engagedS: 1260,
  prompts: 4,
  turnsMain: 3,
  turnsAgent: 2,
  tokens: { in: 1_100_500, out: 315_000, cr: 1_000_000, cw: 200_000 },
  estUsd: 4.4,
  unpricedTurns: 1,
  engineUsd: 3,
  models: [
    { model: 'claude-haiku-4-5', turns: 2, estUsd: 2.5, merged: 0 },
    { model: 'bad model\nname', turns: 1, estUsd: null, merged: 0 },
  ],
  agents: [
    { agentKey: '', merged: 0, turns: 3, model: 'claude-opus-5-5', tokens: { in: 100_500, out: 15_000, cr: 1_000_000, cw: 200_000 }, estUsd: 1.9, share: 1.9 / 4.4 },
    { agentKey: 'abcdef01', merged: 0, turns: 2, model: 'claude-haiku-4-5', tokens: { in: 1_000_000, out: 300_000, cr: 0, cw: 0 }, estUsd: 2.5, share: 2.5 / 4.4 },
  ],
  recommendations: [],
  ...over,
})

describe('footer label', () => {
  test('the hourglass mark and today\'s R&D hours to one decimal: -- before a rollup, 0.0h for a negative or non-finite figure, never past 10 characters', async () => {
    const cases: [number | null, string][] = [
      [null, '\u29D7--'],
      [0, '\u29D70.0h'],
      [8640, '\u29D72.4h'],
      [45_360, '\u29D712.6h'],
      [179, '\u29D70.0h'],
      [181, '\u29D70.1h'],
      [-3600, '\u29D70.0h'],
      [Number.NaN, '\u29D70.0h'],
      [Number.POSITIVE_INFINITY, '\u29D70.0h'],
      [Number.NEGATIVE_INFINITY, '\u29D70.0h'],
      [86_400, '\u29D724.0h'],
      [35_999_640, '\u29D79999.9h'],
      [36_000_000, '\u29D79999h+'],
      [1e15, '\u29D79999h+'],
    ]
    for (const [seconds, label] of cases) {
      expect(footerLabel(seconds)).toBe(label)
      expect([...footerLabel(seconds)].length).toBeLessThanOrEqual(FOOTER_MAX)
      expect(/\p{Extended_Pictographic}/u.test(footerLabel(seconds))).toBe(false)
      expect(footerLabel(seconds)).not.toContain('$')
    }
    expect(TIME_MARK).toBe('\u29D7')
  })
})

describe('session views', () => {
  test('textTable pads every column to its widest cell, figures right-aligned', async () => {
    expect(textTable(['Name', 'N'], [['a', '1'], ['longer', '100']], ['l', 'r'])).toEqual(['Name      N', 'a         1', 'longer  100'])
  })

  test('sessionText: header, engagement, tokens with the cache-hit ratio, both costs, the tables, and no recommendations', async () => {
    const text = sessionText(summary(), ZONE, { showRepo: true })
    const lines = text.split('\n')
    expect(lines[0]).toBe('Session aaaaaaaa · opened 2026-10-11 10:00 · repo secret-project · claude-desktop · 2 segments')
    expect(lines[1]).toBe('Engaged 0.35 h · 4 prompts · 3 main turns · 2 agent turns')
    // cache hit = 1,000,000 / (1,100,500 + 1,000,000 + 200,000) = 43 %
    expect(lines[2]).toBe('Tokens  in 1100500 · out 315000 · cache read 1000000 · cache write 200000 · cache hit 43 %')
    expect(lines[3]).toBe('Cost  engine /cost figure $3.00 · est. $4.40 (list-price estimate, not an invoice)')
    expect(lines[4]).toBe('  1 turn unpriced (no price row for the model)')
    expect(text).toContain('  Model                 Turns   Est.')
    expect(text).toContain('  claude-haiku-4-5          2  $2.50')
    expect(text).toContain('  (unrecognized model)      1     --')
    expect(text).toContain('  Agent     Turns  Model             Tokens   Est.  Share\n  main          3  claude-opus-5-5     1.3M  $1.90   43 %\n  abcdef01      2  claude-haiku-4-5    1.3M  $2.50   57 %')
    expect(lines.at(-1)).toBe('No recommendations for this session')
    expect(text).not.toContain('bad model')
  })

  test('sessionText: a text answer never carries the repository; recommendations are listed', async () => {
    const recs = [{ code: 'errored-turns' as const, text: '3 turns ended in an error and cost about $12.00 with no answer to show for it (estimate).', estSavingUsd: 12 }]
    const text = sessionText(summary({ recommendations: recs, agents: [{ agentKey: 'x\ny', merged: 0, turns: 1, model: null, tokens: { in: 0, out: 0, cr: 0, cw: 0 }, estUsd: null, share: 0 }] }), ZONE, { showRepo: false })
    expect(text).not.toContain('secret-project')
    expect(text).toContain('Recommendations\n  - 3 turns ended in an error')
    expect(text).toContain('(unrecognized agent)')
    expect(text).not.toContain('No recommendations')
  })

  test('sessionText: an others row names how many agents and models it folds', async () => {
    const text = sessionText(
      summary({
        models: [{ model: 'others', turns: 4, estUsd: 0.5, merged: 3 }],
        agents: [{ agentKey: 'others', merged: 5, turns: 9, model: null, tokens: { in: 10, out: 0, cr: 0, cw: 0 }, estUsd: 0.5, share: 0.1 }],
      }),
      ZONE,
      { showRepo: true },
    )
    expect(text).toContain('  3 other models')
    expect(text).toContain('  5 others ')
  })

  test('sessionsText: newest first, at most 40 rows, then how many more and the command', async () => {
    const sessions: SessionRow[] = Array.from({ length: 45 }, (_, i) => {
      const hex = (0xa0000000 + i).toString(16)
      return { sessionId: `${hex}-1111-4111-8111-000000000001`, id8: hex, openedAt: D1 - i * 86_400_000, lastAt: D1, repoKey: 'secret-project', engagedS: 1260, turns: 5, agentCount: 1, engineUsd: i === 1 ? null : 3, estUsd: 4.4, recCount: 0 }
    })
    const text = sessionsText(rollup({ sessions, medianUsdPerHour: 12.5 }), { showRepo: true, shown: 40, hasMore: true })
    const lines = text.split('\n')
    expect(lines[0]).toBe('Sessions this and last month · 45 sessions · cost is the engine /cost figure, ~ marks a list-price estimate, not an invoice')
    expect(lines[1]).toBe('Median est. per engaged hour $12.50 (sessions with at least 0.25 h engaged)')
    expect(lines[3]).toBe('  Date        Session   Repo            Engaged  Turns  Agents    Cost  Recs')
    expect(lines[4]).toBe('  2026-10-11  a0000000  secret-project   0.35 h      5       1   $3.00     0')
    expect(lines[5]).toContain('~$4.40')
    expect(lines.filter(l => /^ {2}20\d\d-/.test(l))).toHaveLength(40)
    expect(lines.at(-1)).toBe('  5 more — press More or /rd session <id8>')
    // After one More: every row, and the line that opens one.
    const all = sessionsText(rollup({ sessions }), { showRepo: true, shown: 80, hasMore: true }).split('\n')
    expect(all.filter(l => /^ {2}20\d\d-/.test(l))).toHaveLength(45)
    expect(all.at(-1)).toBe('  open one with /rd session <id8>')
    const plain = sessionsText(rollup({ sessions }), { showRepo: false, shown: 40, hasMore: false })
    expect(plain.split('\n').at(-1)).toBe('  5 more — /rd session <id8>')
    expect(plain).not.toContain('secret-project')
    expect(plain).not.toContain('Repo')
    expect(sessionsText(rollup(), { showRepo: true, shown: 40, hasMore: true })).toContain('no sessions recorded yet')
  })

  test('sessionOptions: one per listed session, the full id as the value', async () => {
    const row: SessionRow = { sessionId: SID_A, id8: 'aaaaaaaa', openedAt: D1 + 10 * 3_600_000, lastAt: D1 + 12 * 3_600_000, repoKey: 'secret-project', engagedS: 1260, turns: 5, agentCount: 1, engineUsd: 3, estUsd: 4.4, recCount: 0 }
    expect(sessionOptions(rollup({ sessions: [row] }), 40)).toEqual([{ value: SID_A, label: '2026-10-11 aaaaaaaa secret-project $3.00' }])
    expect(sessionOptions(rollup({ sessions: Array.from({ length: 50 }, () => row) }), 45)).toHaveLength(45)
  })
})
