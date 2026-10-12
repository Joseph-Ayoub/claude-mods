import { describe, expect, test } from 'claude-code/testing'

import type { Allocation, Block, Rollup, SessionRow, SessionSummary } from '../types'
import { D1, F1_EXPECTED_ALLOCATIONS, F1_EXPECTED_BLOCKS, F1_UNION_EVENTS, ZONE } from './fixtures/ground-truth'
import { dateOfDay, dayNumber, fitTable, pairLines, FOOTER_MAX, footerLabel, isoWeekOfDate, localClock, LOG_PAGE_LINES, monthBefore, monthlyLogPages, overviewText, rdLines, sessionOptions, sessionsText, sessionText, spendText, summaryLine, textTable, TIME_MARK, tierOf, utcIso, weekDateList, wrapText } from './report'

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
  weekGrossS: 7200,
  todayGrossS: 7200,
  lastWeekTotalS: 3000,
  weekTrend: [
    { week: '2026-W42', netS: 3800, grossS: 7200, confirmed: false },
    { week: '2026-W41', netS: 3000, grossS: 5000, confirmed: true },
  ],
  byEntity: [
    { entity: 'acme', seconds: 2400 },
    { entity: '__unmapped__', seconds: 1400 },
  ],
  byComponent: [
    { component: 'comp-beta', entity: 'acme', activity: 'direct_support', seconds: 1733 },
    { component: '__unmapped__', entity: '', activity: null, seconds: 1400 },
    { component: 'comp-alpha', entity: 'acme', activity: 'direct_research', seconds: 667 },
  ],
  activityMix: [
    { activity: 'direct_research', seconds: 667, poeS: 667 },
    { activity: 'direct_support', seconds: 1733, poeS: 0 },
    { activity: 'non_qualified', seconds: 0, poeS: 0 },
    { activity: 'unclassified', seconds: 1400, poeS: 0 },
  ],
  flaggedDays: [{ date: '2026-10-11', reason: 'block-over-4h', netS: 3000, grossS: 5000 }],
  longestDays: [{ date: '2026-10-12', netS: 3800, grossS: 7200 }],
  entityIds: ['acme'],
  ...over,
})

/** Every line of a text within `width` code points. */
const fits = (text: string, width: number) => {
  for (const line of text.split('\n')) expect([...line].length).toBeLessThanOrEqual(width)
}
/** Lines joined with single spaces, so a wrapped sentence can be matched whole. */
const flat = (text: string) => text.split('\n').map(l => l.trim()).join(' ')

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
  // The R&D view replaced the Overview (rd-tracker's dashboard wording): these three tests were rewritten for it.
  test('R&D view: sections in order with rd-tracker wording, buckets never hidden, totals last, the queue as a count', async () => {
    const text = overviewText(rollup(), 120)
    const order = ['R&D ledger · week of Oct 12 – Oct 18 · America/New_York · union-v2/a5db146c', 'Hours in range', 'Weekly trend', 'Hours by entity', 'Hours by component', 'Activity mix', 'Review status', 'Spend this month', 'Pipeline', 'Deadlines']
    const lines = text.split('\n')
    const positions = order.map(t => lines.indexOf(t))
    expect(positions.every(p => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    // One blank line between sections.
    for (const p of positions.slice(1)) expect(lines[p - 1]).toBe('')
    expect(text).toContain('  Net hours       1.06\n    engaged time, gaps removed; the figure a claim is built from')
    // The caption names what gross measures: the day's first to last admitted prompt (verifier V7).
    expect(text).toContain('  Gross span      2.00\n    first to last prompt each day, gaps included (context, not a claim basis)')
    expect(text).toContain('  Today           1.06')
    expect(text).toContain('  up 26.7% vs last week')
    expect(text).toContain('  ISO week  Net hours  Gross span\n  2026-W42       1.06        2.00\n  2026-W41       0.83        1.39\n  Total          1.89        3.39')
    expect(text).toContain('  Entity    Net hours\n  acme           0.67\n  non-R&D        0.00\n  unmapped       0.39\n  ignored        0.00\n  Total          1.06')
    expect(text).toContain('  Component   Entity  Activity         Net hours\n  comp-beta   acme    direct_support        0.48\n  comp-alpha  acme    direct_research       0.19\n  non-R&D     (none)  -                     0.00\n  unmapped    (none)  -                     0.39\n  ignored     (none)  -                     0.00\n  Total                                     1.06')
    expect(text).toContain('  Activity type    Net hours\n  direct_research       0.19\n  direct_support        0.48\n  unclassified          0.39\n  Total                 1.06')
    expect(text).not.toContain('non_qualified')
    expect(text).toContain('  Process-of-experimentation share: 0.19 of 0.67 qualified-services hours (27.8%)')
    expect(text).toContain('  0.39 hours in the review queue · 1 unmapped repo(s), 1 session(s)')
    expect(text).toContain('  Unconfirmed weeks\n    2026-W42  unconfirmed  1.06\n    2026-W41  1 row(s) changed since confirmation')
    expect(text).toContain('  Days to adjudicate\n    2026-10-11  block over the 4 h cap  0.83 net · 1.39 gross')
    expect(text).toContain('  Confirm weeks in Review (v) — hours are proposals until confirmed.')
    expect(text).toContain('  ~$13.25 est. list price · Spend (s)')
    for (const fact of ['  never exported', '  bridge corroborate (rd-tracker reachable)', '  3 sessions · 3 segments in scope · 1 unreadable', '  denied events: automation-entrypoint 1 · origin:task-notification 1', '  2 redactions · 0 dropped rows', '  prices as of 2026-10-06', '  zone America/New_York (this Mac now reads Europe/Paris)', '  warning: the store is a symbolic link']) expect(lines).toContain(fact)
    expect(lines).toContain('  first mandatory tax year: TY2026  Form 6765 Section G becomes mandatory — no calendar date — see due')
    expect(lines).toContain('  2026-07-06  §70302(f)(1) retroactive §174A election window closes — CLOSED 98 day(s) ago')
    expect(lines).toContain('  2027-04-15  Form 1120 (C-corp) · acme — 185 day(s) remaining')
    expect(lines).toContain('  Section G exemption · acme — unknown')
    expect(lines.at(-1)).toBe('  Calendar tax year; dates are not moved for weekends or holidays; verify with your CPA.')
    // never a repo key, a branch, a flag's free text or a path
    for (const banned of ['secret-project', 'hidden-name', 'abcdef012345', '/Users/', 'a detail with']) expect(text).not.toContain(banned)
    // The pane draws titles bold and captions dim from the same lines.
    const drawn = rdLines(rollup(), 120)
    expect(drawn.find(l => l.text === 'Activity mix')?.style).toBe('title')
    expect(drawn.find(l => l.text.includes('gaps removed'))?.style).toBe('dim')
  })
  test('R&D view: no prior period, no change, over 999%, no flags and an empty week', async () => {
    expect(overviewText(rollup({ lastWeekTotalS: 0 }), 100)).toContain('  no prior period')
    expect(overviewText(rollup({ lastWeekTotalS: 3800 }), 100)).toContain('  no change vs last week')
    expect(overviewText(rollup({ lastWeekTotalS: 300 }), 100)).toContain('  up over 999% vs last week')
    expect(overviewText(rollup({ weekTotalS: 1000 }), 100)).toContain('  down 66.7% vs last week')
    const calm = overviewText(rollup({ flaggedDays: [], weekTrend: [{ week: '2026-W42', netS: 3800, grossS: 7200, confirmed: true }], reviews: [] }), 100)
    expect(calm).toContain('  Every week with recorded time is confirmed.')
    expect(calm).toContain('  Longest days (no flags)\n    2026-10-12  1.06 net · 2.00 gross')
    expect(calm).not.toContain('Days to adjudicate')
    const empty = overviewText(rollup({ flaggedDays: [], longestDays: [], activityMix: [], byEntity: [], byComponent: [] }), 100)
    expect(empty).toContain('    no time recorded this week')
    expect(empty).toContain('(n/a)')
  })
  test('R&D view: every line fits 40, 60, 84 and 120 columns; tables drop columns by tier; free text wraps', async () => {
    const stale = rollup({ health: { ...rollup().health, lockStaleMs: 25 * 60_000 } })
    for (const width of [24, 40, 60, 84, 120]) fits(overviewText(stale, width), width)
    expect([tierOf(40), tierOf(59), tierOf(60), tierOf(83), tierOf(84)]).toEqual(['narrow', 'narrow', 'medium', 'medium', 'wide'])
    const narrow = overviewText(stale, 40)
    expect(narrow).toContain('  ISO week  Net hours\n')
    expect(narrow).not.toContain('Net hours  Gross span')
    expect(narrow).toContain('  Component   Net hours\n')
    const medium = overviewText(stale, 60)
    expect(medium).toContain('  Component   Entity  Net hours\n')
    expect(medium).not.toContain('Activity  ')
    expect(overviewText(stale, 84)).toContain('  Component   Entity  Activity')
    // A long warning and a caption wrap onto further lines, whole, never cut with an ellipsis.
    expect(flat(narrow)).toContain('warning: a store lock from a crashed session is 25 min old; saves and hand-offs wait until it is cleared with Clear stale lock (l)')
    expect(flat(narrow)).toContain('first to last prompt each day, gaps included (context, not a claim basis)')
    expect(narrow.split('\n').filter(l => l.includes('first to last prompt')).length).toBe(1)
    expect(narrow.split('\n').some(l => l.endsWith('…') && /gaps|warning|stale/.test(l))).toBe(false)
    expect(overviewText(stale, Number.NaN).split('\n').every(l => [...l].length <= 80)).toBe(true)
  })
  test('R&D view: hostile ids, zones and reasons are drawn as placeholders, never as lines', async () => {
    const hostile = rollup({
      zone: 'Evil\nZone',
      byComponent: [{ component: 'Bad Name\n__forged__ 99.00 h', entity: 'acme‮', activity: 'direct_research', seconds: 60 }],
      byEntity: [{ entity: 'evil\nentity', seconds: 60 }],
      entityIds: ['x\ny'],
      health: { ...rollup().health, deniedByReason: { 'ghp_abcdefghijklmnopqrst\nrow': 3 } },
    })
    const text = overviewText(hostile, 200)
    expect(text).not.toContain('__forged__')
    expect(text).not.toContain('ghp_')
    expect(text).not.toContain('‮')
    expect(text).not.toContain('evil')
    expect(text).toContain('(unrecognized id)')
    expect(text).toContain('(unrecognized zone)')
    expect(text).toContain('(unrecognized reason) 3')
    expect(text).toContain('Section G exemption · (unrecognized id) — unknown')
  })
  test('fitTable: a figure is never cut; past the shrinking, columns go in their drop order', async () => {
    const cols = [{ head: 'Model', align: 'l' as const }, { head: 'Turns', align: 'r' as const, drop: 2 }, { head: 'Output', align: 'r' as const, drop: 1 }, { head: 'Est.', align: 'r' as const }]
    const lines = fitTable(cols, [['claude-opus-5-5', '10', '98.8M', '$12345.67']], 24)
    expect(lines).toEqual(['  Model             Est.', '  claude-opu…  $12345.67'])
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(24)
    expect(lines[1]?.endsWith('$12345.67')).toBe(true)
    expect(lines[0]).not.toContain('Output')
    expect(lines[0]).not.toContain('Turns')
    // At 30 only the first in the drop order goes.
    const wider = fitTable(cols, [['claude-opus-5-5', '10', '98.8M', '$12345.67']], 32)
    expect(wider[0]).toContain('Turns')
    expect(wider[0]).not.toContain('Output')
    expect(wider[1]?.endsWith('$12345.67')).toBe(true)
  })
  test('pairLines: the value is never cut; a pair that cannot share a line stacks, label first', async () => {
    expect(pairLines('Engaged hours', '0.35', 24, 14)).toEqual(['  Engaged hours     0.35'])
    for (const width of [24, 26, 27, 28, 40]) {
      const lines = pairLines('Input tokens', '1100500', width, width < 60 ? 14 : 20)
      for (const l of lines) expect([...l].length).toBeLessThanOrEqual(width)
      expect(lines.join('\n')).toContain('1100500')
      expect(lines.join('\n')).toContain('Input tokens')
      expect(lines.join('')).not.toContain('…')
    }
    expect(pairLines('Input tokens', '1100500', 24, 14)).toEqual(['  Input tokens   1100500'])
    expect(pairLines('Engine /cost', '$12345.67', 24, 14)).toEqual(['  Engine /cost', '    $12345.67'])
  })
  test('at 24 columns: Sessions keeps the cost, the Session view keeps every figure and wraps its last line, the trend lists every week with the oldest partial', async () => {
    const row: SessionRow = { sessionId: SID_A, id8: 'aaaaaaaa', openedAt: D1 + 10 * 3_600_000, lastAt: D1, repoKey: 'secret-project', engagedS: 1260, turns: 5, agentCount: 1, engineUsd: 12345.67, estUsd: 4.4, recCount: 0 }
    const list = sessionsText(rollup({ sessions: [row] }), { showRepo: true, shown: 40, hasMore: true }, 24)
    fits(list, 24)
    expect(list).toContain('  aaaaaaaa  $12345.67')
    const one = sessionText(summary({ engineUsd: 12345.67 }), ZONE, { showRepo: true }, 24)
    fits(one, 24)
    expect(one).not.toMatch(/[0-9$%]…$/m)
    expect(one).toContain('    $12345.67')
    expect(one.split('\n').slice(-2)).toEqual(['No recommendations for', '  this session'])
    // Ten weeks in scope: all listed, the Total foots them all, the oldest (W36 starts 08-31, before 09-01) partial.
    const weeks = Array.from({ length: 10 }, (_, i) => ({ week: `2026-W${String(45 - i).padStart(2, '0')}`, netS: 19_800, grossS: 19_800, confirmed: true }))
    const trend = overviewText(rollup({ today: '2026-10-05', weekTrend: weeks }), 24)
    fits(trend, 24)
    // At 24 the tag is never cut: the week stands alone in its row and a dim line under the table says it is partial.
    expect(trend).not.toContain('(…')
    expect(trend).toMatch(/\n {2}2026-W36 +5\.50\n/)
    expect(flat(trend)).toContain('(partial) 2026-W36 starts before the first of last month; only its in-scope days count')
    expect(trend).not.toContain('2026-W37 starts')
    expect(trend).toMatch(/\n {2}Total +55\.00\n/)
    const wide = overviewText(rollup({ today: '2026-10-05', weekTrend: weeks }), 100)
    expect(wide).toContain('  2026-W36 (partial)')
    expect(wide).not.toContain('2026-W37 (partial)')
    expect(wide).toMatch(/\n {2}Total +55\.00 +55\.00\n/)
    expect(pairLines('Until compaction', '120k', 40, 14)).toEqual(['  Until compaction', '    120k'])
  })
  test('wrapText and fitTable: indents, hard splits, whitespace runs, and shrinking text columns', async () => {
    expect(wrapText('alpha beta gamma delta', 12, 2)).toEqual(['  alpha beta', '    gamma', '    delta'])
    expect(wrapText('abcdefghijklmnop', 6, 0)).toEqual(['abcdef', '  ghij', '  klmn', '  op'])
    expect(wrapText('2026-10-11  0.33 h  pretag', 80, 4)).toEqual(['    2026-10-11  0.33 h  pretag'])
    expect(wrapText('', 10, 2)).toEqual([''])
    for (const line of wrapText('x'.repeat(50), 3, 8)) expect([...line].length).toBeLessThanOrEqual(3)
    expect(fitTable([{ head: 'Name', align: 'l' }, { head: 'N', align: 'r' }], [['a', '1'], ['longer', '100']], 80)).toEqual(['  Name      N', '  a         1', '  longer  100'])
    expect(fitTable([{ head: 'Name', align: 'l' }, { head: 'N', align: 'r' }], [['a-very-long-name', '1']], 14)).toEqual(['  Name       N', '  a-very-l…  1'])
  })
  test('summary line', async () => {
    expect(summaryLine(rollup())).toBe('R&D: 1.06 h this week · 1.06 h today · 1 unmapped · week 2026-W42 open')
    expect(summaryLine(rollup({ reviews: [{ week: '2026-W42', confirmed: true, rev: 3, changedRows: 0 }] }))).toBe('R&D: 1.06 h this week · 1.06 h today · 1 unmapped · week 2026-W42 confirmed rev 3')
    expect(summaryLine(rollup({ week: 'W42\nx', weekTotalS: Number.NaN }))).toBe('R&D: 0.00 h this week · 1.06 h today · 1 unmapped · week (unrecognized week) open')
  })
  test('spend: by model and by component, labelled, both months; tokens compact; unpriced turns named', async () => {
    const text = spendText(rollup())
    const lines = text.split('\n')
    expect(lines[0]).toBe('Spend · list-price estimate, not an invoice · prices as of 2026-10-06')
    expect(text).toContain('This month 2026-10: $13.25 estimated')
    expect(text).toContain('    Model                 Turns  Input  Output  Cache read  Cache write    Est.')
    expect(text).toContain('    claude-opus-5-5          10   1000    2000       30.0k          400  $12.50')
    expect(text).toContain('    (unrecognized model)      2      5       5           0            0   $0.00')
    expect(text).toContain('    (unrecognized model): 2 turns unpriced (no price row for the model)')
    expect(lines.some(l => /^ {4}comp-alpha +acme +10 +\$12\.50$/.test(l))).toBe(true)
    expect(lines.some(l => /^ {4}__unmapped__ +- +2 +\$0\.00$/.test(l))).toBe(true)
    expect(text).toContain('engine /cost figure $11.10 over 3 segments')
    expect(text).toContain('Last month 2026-09: $0.00 estimated')
    expect(flat(text)).toContain("The estimate excludes the engine's side calls (compaction, titles); the engine /cost figure is the engine's own number.")
  })
  test('spend: the by-model table drops cache write and input (medium), then cache read (narrow); every line fits', async () => {
    for (const width of [24, 40, 60, 84, 120]) fits(spendText(rollup(), width), width)
    expect(spendText(rollup(), 84)).toMatch(/\n {4}Model +Turns +Input +Output +Cache read +Cache write +Est\.\n/)
    const medium = spendText(rollup(), 60)
    expect(medium).toMatch(/\n {4}Model +Turns +Output +Cache read +Est\.\n/)
    const narrow = spendText(rollup(), 40)
    expect(narrow).toMatch(/\n {4}Model +Turns +Output +Est\.\n/)
    expect(narrow).not.toMatch(/Component +Entity/)
    expect(flat(narrow)).toContain('Cache writes are priced at the cache TTL in force for each turn (the cacheTtl option where the session recorded none): x1.25 input for 5m, x2.0 for 1h.')
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

  // Rewritten for the headline pairs (a label column, right-aligned values) that replaced the run-on lines.
  test('sessionText: header, engagement, tokens with the cache-hit ratio, both costs, the tables, and no recommendations', async () => {
    const text = sessionText(summary(), ZONE, { showRepo: true })
    const lines = text.split('\n')
    expect(lines[0]).toBe('Session aaaaaaaa · opened 2026-10-11 10:00 · repo secret-project · claude-desktop · 2 segments')
    const pairs = ['  Engaged hours               0.35', '  Prompts                        4', '  Main turns                     3', '  Agent turns                    2', '  Input tokens             1100500', '  Output tokens             315000', '  Cache read               1000000', '  Cache write               200000', '  Cache hit                   43 %', '  Engine /cost               $3.00', '  Estimate                   $4.40']
    // cache hit = 1,000,000 / (1,100,500 + 1,000,000 + 200,000) = 43 %
    expect(lines.slice(2, 13)).toEqual(pairs)
    expect(lines[13]).toBe('    the estimate is a list-price estimate, not an invoice')
    expect(lines[14]).toBe('    1 turn unpriced (no price row for the model)')
    expect(text).toContain('  Model                 Turns   Est.')
    expect(text).toContain('  claude-haiku-4-5          2  $2.50')
    expect(text).toContain('  (unrecognized model)      1     --')
    expect(text).toContain('  Agent     Turns  Model             Tokens   Est.  Share\n  main          3  claude-opus-5-5     1.3M  $1.90   43 %\n  abcdef01      2  claude-haiku-4-5    1.3M  $2.50   57 %')
    expect(lines.at(-1)).toBe('No recommendations for this session')
    expect(text).not.toContain('bad model')
  })

  test('sessionText at 40 columns: the header splits, the label column narrows, agents drop model and tokens, a long recommendation wraps', async () => {
    const long = 'The main loop re-read a median of 180.0k cached tokens on each of 42 turns; cache reads cost $9.10 of this session, so /compact or a fresh session for the next task would trim that (estimate).'
    const text = sessionText(summary({ recommendations: [{ code: 'context-size', text: long, estSavingUsd: null }] }), ZONE, { showRepo: true }, 40)
    fits(text, 40)
    const lines = text.split('\n')
    expect(lines.slice(0, 5)).toEqual(['Session aaaaaaaa', '  opened 2026-10-11 10:00', '  repo secret-project', '  claude-desktop', '  2 segments'])
    expect(lines).toContain('  Engaged hours         0.35')
    expect(text).toContain('  Agent     Turns   Est.  Share')
    expect(text).not.toContain('Tokens')
    const recs = lines.slice(lines.indexOf('Recommendations') + 1)
    expect(recs.length).toBeGreaterThan(3)
    expect(recs[0]?.startsWith('  - The main loop')).toBe(true)
    expect(recs.slice(1).every(l => l.startsWith('    '))).toBe(true)
    expect(flat(recs.join('\n'))).toBe(`- ${long}`)
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

  // Rewritten: the title wraps at the width, and the hours column reads two decimals without a unit.
  test('sessionsText: newest first, at most 40 rows, then how many more and the command', async () => {
    const sessions: SessionRow[] = Array.from({ length: 45 }, (_, i) => {
      const hex = (0xa0000000 + i).toString(16)
      return { sessionId: `${hex}-1111-4111-8111-000000000001`, id8: hex, openedAt: D1 - i * 86_400_000, lastAt: D1, repoKey: 'secret-project', engagedS: 1260, turns: 5, agentCount: 1, engineUsd: i === 1 ? null : 3, estUsd: 4.4, recCount: 0 }
    })
    const text = sessionsText(rollup({ sessions, medianUsdPerHour: 12.5 }), { showRepo: true, shown: 40, hasMore: true })
    fits(text, 100)
    const lines = text.split('\n')
    expect(flat(text)).toContain('Sessions this and last month · 45 sessions · cost is the engine /cost figure, ~ marks a list-price estimate, not an invoice')
    expect(lines).toContain('  Median est. per engaged hour $12.50 (sessions with at least 0.25 h engaged)')
    const head = lines.findIndex(l => l.startsWith('  Date'))
    expect(lines[head]).toBe('  Date        Session   Repo            Hours  Turns  Agents    Cost  Recs')
    expect(lines[head + 1]).toBe('  2026-10-11  a0000000  secret-project   0.35      5       1   $3.00     0')
    expect(lines[head + 2]).toContain('~$4.40')
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
    // The table gives up Recs (medium), then Agents and Repo (narrow, where the date drops its year).
    for (const width of [24, 40, 60, 84, 120]) fits(sessionsText(rollup({ sessions }), { showRepo: true, shown: 40, hasMore: true }, width), width)
    const medium = sessionsText(rollup({ sessions }), { showRepo: true, shown: 40, hasMore: true }, 60)
    expect(medium).toMatch(/ {2}Date +Session +Repo +Hours +Turns +Agents +Cost\n/)
    const narrow = sessionsText(rollup({ sessions }), { showRepo: true, shown: 40, hasMore: true }, 40).split('\n')
    expect(narrow).toContain('  Date   Session   Hours  Turns    Cost')
    expect(narrow).toContain('  10-11  a0000000   0.35      5   $3.00')
  })

  test('sessionOptions: one per listed session, the full id as the value', async () => {
    const row: SessionRow = { sessionId: SID_A, id8: 'aaaaaaaa', openedAt: D1 + 10 * 3_600_000, lastAt: D1 + 12 * 3_600_000, repoKey: 'secret-project', engagedS: 1260, turns: 5, agentCount: 1, engineUsd: 3, estUsd: 4.4, recCount: 0 }
    expect(sessionOptions(rollup({ sessions: [row] }), 40)).toEqual([{ value: SID_A, label: '2026-10-11 aaaaaaaa secret-project $3.00' }])
    expect(sessionOptions(rollup({ sessions: Array.from({ length: 50 }, () => row) }), 45)).toHaveLength(45)
  })
})
