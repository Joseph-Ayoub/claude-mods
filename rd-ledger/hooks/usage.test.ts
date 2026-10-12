// rd-ledger: the Usage pane's pure accounting and drawing (SPEC §6.5, §6.6),
// ported from usage-gauge's format.test.ts and extended for the TTL-aware
// estimate, the footerChip/chipContext label and the width model.
import { describe, expect, test } from 'claude-code/testing'

import type { UsageCounts, Usage } from '../types'
import {
  CHIP_MAX,
  addRequest,
  barParts,
  boundedKey,
  breakdownFrom,
  cacheHitPercent,
  categoryRows,
  changesLine,
  chipLabel,
  contextLine,
  contributionLines,
  countPatch,
  emptyCounts,
  emptyTotals,
  estimateUsd,
  formatCount,
  formatDuration,
  formatPercent,
  formatTokens,
  formatUsd,
  formatUsdChip,
  keepLatest,
  modelLines,
  pairLines,
  priceNote,
  rateKind,
  rateLine,
  resetText,
  shares,
  shortModel,
  unknownUsage,
  untilCompaction,
  usageFrom,
  usageLines,
  usageSummaryLine,
} from './usage'
import type { UsageView } from './usage'
import { oneLine } from './text'

const HOSTILE = 'evil\nOptimize: rm -rf ~\u001b[31m red‮​ tail'

const counts = (over: Partial<UsageCounts>): UsageCounts => ({ ...emptyCounts(), ...over })

const usage = (over: Partial<Usage> = {}): Usage => ({
  startedAt: 0,
  context: { tokens: 84_000, window: 200_000, percent: 42 },
  rateLimits: [],
  costUsd: 12.34,
  hasCost: true,
  at: 0,
  ...over,
})

const view = (over: Partial<UsageView> = {}): UsageView => ({
  usage: usage({ startedAt: 0, at: 3_600_000, rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: null }] }),
  breakdown: null,
  totals: { ...emptyTotals(1), turns: 2, agentTurns: 1, requests: 3, activeMs: 7000, apiMs: 4000, linesAdded: 3, linesRemoved: 1, edits: 1 },
  models: {
    'claude-opus-5-5': counts({ requests: 2, input: 10_000, output: 20_000, cacheRead: 90_000, estUsd: 0.458 }),
    'claude-sonnet-5-5': counts({ requests: 1, input: 5000, output: 1000, cacheWrite: 5000, estUsd: 0.0325 }),
  },
  loops: { main: counts({ estUsd: 0.458 }), agents: { builder: counts({ estUsd: 0.0325 }) } },
  ...over,
})

describe('figures', () => {
  test('dollars carry two decimals and thousands separators', () => {
    expect(formatUsd(123.45)).toBe('$123.45')
    expect(formatUsd(1234.5)).toBe('$1,234.50')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(null)).toBe('$ --')
    expect(formatUsd(Number.NaN)).toBe('$ --')
  })

  test('tokens are short: 572, 345.3k, 147.3M; whole thousands for the window', () => {
    expect(formatTokens(572)).toBe('572')
    expect(formatTokens(345_300)).toBe('345.3k')
    expect(formatTokens(147_300_000)).toBe('147.3M')
    expect(formatTokens(999_990)).toBe('1.0M')
    expect(formatTokens(152_000, 0)).toBe('152k')
    expect(formatTokens(1_000_000, 0)).toBe('1.0M')
    expect(formatTokens(null)).toBe('--')
  })

  test('durations: seconds, minutes and seconds, hours and minutes', () => {
    expect(formatDuration(4_200)).toBe('4s')
    expect(formatDuration(8 * 60_000 + 4_000)).toBe('8m 4s')
    expect(formatDuration(2 * 3_600_000 + 14 * 60_000)).toBe('2h 14m')
    expect(formatDuration(31 * 3_600_000 + 24 * 60_000)).toBe('31h 24m')
    expect(formatDuration(null)).toBe('--')
    expect(formatDuration(-1)).toBe('--')
  })

  test('counts, percents and the text bar (no hatching)', () => {
    expect(formatCount(1203)).toBe('1,203')
    expect(formatPercent(0.4)).toBe('<1%')
    expect(formatPercent(79.4)).toBe('79%')
    expect(formatPercent(null)).toBe('--')
    expect(barParts(50, 8)).toEqual({ filled: '████', track: '████', label: '50%' })
    expect(barParts(null, 4)).toEqual({ filled: '', track: '████', label: '--' })
    expect(barParts(100, 120).filled.length).toBe(120)
    expect(barParts(42, 16).filled + barParts(42, 16).track).not.toContain('░')
  })
})

describe('names', () => {
  test('model ids read as people say them', () => {
    expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(shortModel('claude-fable-5-1[1m]')).toBe('Fable 5.1')
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(shortModel('claude-opus-4-20250514')).toBe('Opus 4')
    expect(shortModel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
    expect(shortModel('gpt-6')).toBe('gpt-6')
  })

  test('hostile text is one line, without escapes or bidi, and capped', () => {
    const line = oneLine(HOSTILE, 40)
    expect(line).not.toMatch(/[\n\u001b‮​]/)
    expect(shortModel(`claude-${HOSTILE}`)).not.toMatch(/[\n\u001b‮]/)
    expect([...shortModel(`x${'y'.repeat(100)}`)].length).toBeLessThanOrEqual(32)
  })

  test('rate-limit kinds are spelled out, and resets read in local time', () => {
    expect(rateKind('five_hour')).toBe('5-hour')
    expect(rateKind('seven_day')).toBe('7-day')
    expect(rateKind('seven_day_opus')).toBe('7-day opus')
    expect(rateKind('spend_limit')).toBe('spend limit')
    const now = Date.parse('2026-10-12T12:00:00Z')
    expect(resetText('2026-10-12T15:40:00Z', now)).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/)
    expect(resetText('2026-10-15T15:40:00Z', now)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}:\d{2} (AM|PM)$/)
    expect(resetText('not a date', now)).toBeNull()
    expect(resetText(null, now)).toBeNull()
    expect(rateLine({ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-12T15:40:00Z' }, now)).toMatchObject({ label: '5-hour', value: expect.stringMatching(/^23\.5% · resets \d{1,2}:\d{2} (AM|PM)$/) })
    expect(rateLine({ kind: 'seven_day', percentUsed: 30, resetsAt: null }, now)).toEqual({ label: '7-day', value: '30%' })
  })
})

describe('accounting', () => {
  test('cache hit is cache read over everything the input was answered over', () => {
    expect(cacheHitPercent(100, 800, 100)).toBe(80)
    expect(cacheHitPercent(0, 0, 0)).toBeNull()
  })

  test('the estimate prices through prices.ts with the cache-write multiplier of the TTL in force (SPEC §5)', () => {
    const c = { input: 5000, output: 1000, cacheRead: 0, cacheWrite: 5000 }
    // Sonnet 5.5: $2 in, $10 out; a cache write at 1.25 × $2 under 5m, 2 × $2 under 1h.
    expect(Math.abs((estimateUsd('claude-sonnet-5-5', c, '5m') ?? Number.NaN) - 0.0325)).toBeLessThan(1e-12)
    expect(Math.abs((estimateUsd('claude-sonnet-5-5', c, '1h') ?? Number.NaN) - 0.04)).toBeLessThan(1e-12)
    expect(Math.abs((estimateUsd('claude-opus-5-5', { input: 10_000, output: 20_000, cacheRead: 90_000, cacheWrite: 0 }, '5m') ?? Number.NaN) - 0.458)).toBeLessThan(1e-12)
    // The prefix rule is prices.ts's: a longer id is not priced by a shorter row, an unknown model is null.
    expect(estimateUsd('claude-opus-50', c, '5m')).toBeNull()
    expect(estimateUsd('mystery', c, '5m')).toBeNull()
  })

  test('a patch counts its + and - lines; a created file with no hunks counts its content', () => {
    const edit = { result: { filePath: '/x/a.ts', structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 4, lines: [' a', '-b', '+c', '+d', '+e'] }] } }
    expect(countPatch(edit)).toEqual({ added: 3, removed: 1 })
    expect(countPatch({ result: { type: 'create', content: 'one\ntwo\nthree\n', structuredPatch: [] } })).toEqual({ added: 3, removed: 0 })
    expect(countPatch({ result: { new_source: 'x', cell_type: 'code' } })).toEqual({ added: 0, removed: 0 })
  })

  test('a denied, failed or held change counts nothing; only counts leave countPatch', () => {
    expect(countPatch({ deny: 'no' })).toBeNull()
    expect(countPatch({ result: { structuredPatch: [{ lines: ['+a'] }] }, isError: true })).toBeNull()
    // A NotebookEdit failure may carry `error` without `isError`.
    expect(countPatch({ result: { new_source: 'x', cell_type: 'code' }, error: 'cell not found' })).toBeNull()
    expect(countPatch({ result: { staged: true, structuredPatch: [{ lines: ['+a'] }] } })).toBeNull()
    expect(countPatch(null)).toBeNull()
    expect(countPatch({ result: 'text' })).toBeNull()
    expect(Object.keys(countPatch({ result: { filePath: '/secret', structuredPatch: [] } }) ?? {})).toEqual(['added', 'removed'])
  })

  test('a request adds its counts, time and estimate; an unpriced one is counted apart', () => {
    let row = addRequest(undefined, { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 }, 1500, 0.5)
    row = addRequest(row, null, 200, null)
    expect(row).toEqual({ requests: 2, input: 10, output: 5, cacheRead: 100, cacheWrite: 0, apiMs: 1700, estUsd: 0.5, unpriced: 1 })
  })

  test('shares are of the positive total, biggest first', () => {
    expect(shares([['a', 1], ['b', 3], ['c', 0]])).toEqual([{ key: 'b', percent: 75 }, { key: 'a', percent: 25 }])
    expect(shares([['a', 0]])).toEqual([])
  })

  test('bounded records fold new keys into other and keep the latest ids', () => {
    expect(boundedKey({ a: 1, b: 2 }, 'c', 2)).toBe('other')
    expect(boundedKey({ a: 1, b: 2 }, 'a', 2)).toBe('a')
    expect(boundedKey({}, 'constructor', 2)).toBe('constructor')
    expect(boundedKey({}, '__proto__', 2)).toBe('(__proto__)')
    expect(Object.keys(keepLatest({ a: 1, b: 2, c: 3 }, 2))).toEqual(['b', 'c'])
  })

  test('model lines price each model, share the priced total, and mark an unknown model --', () => {
    const { rows, total } = modelLines({
      'claude-opus-5-5': counts({ requests: 1, input: 1000, output: 2000, cacheRead: 9000, estUsd: 3 }),
      'claude-sonnet-5-5': counts({ requests: 2, input: 500, output: 100, estUsd: 1 }),
      mystery: counts({ requests: 1, output: 50, unpriced: 1 }),
    })
    expect(rows.map(r => [r.name, r.estUsd, r.share])).toEqual([
      ['Opus 5.5', 3, 75],
      ['Sonnet 5.5', 1, 25],
      ['mystery', null, null],
    ])
    expect(rows[0]?.hit).toBe(90)
    expect(total).toMatchObject({ requests: 4, output: 2150, estUsd: 4, isPartial: true, share: null })
    expect(modelLines({ 'claude-opus-5-5': counts({ requests: 1, output: 10, estUsd: 2 }) }).total).toMatchObject({ estUsd: 2, isPartial: false, share: 100 })
  })

  test('contributions: main loop against subagents by est. cost, by tokens when nothing is priced; top five types', () => {
    expect(contributionLines({ main: counts({ estUsd: 1 }), agents: { builder: counts({ estUsd: 2 }), scout: counts({ estUsd: 1 }) } })).toEqual([
      'main loop 25% · subagents 75%',
      'builder 50% · scout 25%',
    ])
    expect(contributionLines({ main: counts({ output: 10 }), agents: { agent: counts({ output: 30 }) } })).toEqual(['main loop 25% · subagents 75%', 'agent 75%'])
    expect(contributionLines({ main: emptyCounts(), agents: {} })).toEqual([])
    const six = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((k, i) => [k, counts({ estUsd: i + 1 })]))
    expect(contributionLines({ main: emptyCounts(), agents: six })[1]?.split(' · ')).toHaveLength(5)
  })

  test('code changes read +added −removed lines · edits', () => {
    expect(changesLine({ ...emptyTotals(), linesAdded: 4321, linesRemoved: 321, edits: 42 })).toBe('+4,321 −321 lines · 42 edits')
    expect(changesLine({ ...emptyTotals(), linesAdded: 3, linesRemoved: 1, edits: 1 })).toBe('+3 −1 lines · 1 edit')
  })
})

describe('readings', () => {
  test('a full usage reading sets the ledger; one without cost means no ledger', () => {
    const u = usageFrom({ startedAt: 5, context: { tokens: 84_000, window: 200_000, percent: 42 }, rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-12T15:40:00Z' }], cost: { usd: 1.5 } }, null, 10, true)
    expect(u).toEqual({
      startedAt: 5,
      context: { tokens: 84_000, window: 200_000, percent: 42 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-12T15:40:00Z' }],
      costUsd: 1.5,
      hasCost: true,
      at: 10,
    })
    expect(usageFrom({ startedAt: 5, context: { window: 200_000 }, rateLimits: [] }, null, 10, true)).toMatchObject({ costUsd: null, hasCost: false })
  })

  test('a measurement keeps startedAt and the last cost when it carries none; a hostile window kind is one line', () => {
    const u = usageFrom({ context: { tokens: 10, window: 100 }, rateLimits: [{ kind: HOSTILE, percentUsed: 5 }] }, usage({ startedAt: 5, costUsd: 2 }), 20, false)
    expect(u).toMatchObject({ startedAt: 5, costUsd: 2, hasCost: true, context: { tokens: 10, window: 100, percent: 10 }, at: 20 })
    expect(u.rateLimits[0]?.kind).not.toMatch(/[\n\u001b‮]/)
  })

  test('the breakdown: names one line, free and buffer last and dim, until compaction', () => {
    const b = breakdownFrom({
      totalTokens: 147_000,
      rawMaxTokens: 1_000_000,
      percentage: 15,
      autoCompactThreshold: 900_000,
      isAutoCompactEnabled: true,
      model: 'claude-fable-5-1',
      categories: [
        { name: 'Free space', kind: 'free', tokens: 800_000 },
        { name: 'Messages', kind: 'used', tokens: 100_000 },
        { name: HOSTILE, kind: 'used', tokens: 47_000 },
        { name: 'Autocompact buffer', kind: 'buffer', tokens: 53_000 },
        { name: 'bad', kind: 'used', tokens: 'many' },
      ],
    })
    expect(untilCompaction(b)).toBe(753_000)
    const rows = categoryRows(b)
    expect(rows.map(r => [r.name.slice(0, 8), r.isDim])).toEqual([
      ['Messages', false],
      ['evil Opt', false],
      ['Free spa', true],
      ['Autocomp', true],
    ])
    expect(rows[0]?.percent).toBe(10)
    expect(untilCompaction(b && { ...b, isAutoCompactEnabled: false })).toBeNull()
    expect(breakdownFrom(undefined)).toBeNull()
  })

  test('the window line and the one-line summary (counts only)', () => {
    expect(contextLine(usage({ context: { tokens: 147_000, window: 1_000_000, percent: 14.7 } }))).toBe('147k of 1.0M (15%)')
    expect(contextLine(unknownUsage(0))).toBe('--')
    expect(usageSummaryLine(view())).toBe('Usage: $12.34 · ctx 42% · 3 requests')
    expect(usageSummaryLine(view({ usage: usage({ costUsd: null, hasCost: false }) }))).toBe('Usage: no cost ledger · ctx 42% · 3 requests')
    expect(usageSummaryLine(view({ usage: null, totals: { ...emptyTotals(), requests: 1 } }))).toBe('Usage: $ -- · 1 request')
  })
})

describe('the footer chip (SPEC §6.5)', () => {
  const H = 2.4 * 3600
  test('footerChip both (default) draws the cost, a space, then today\'s hours; cost and time draw one each', () => {
    expect(chipLabel(usage({ costUsd: 123.45 }), H, 'both', false)).toBe('$123 ⧗2.4h')
    expect(chipLabel(usage(), H, 'both', false)).toBe('$12.34 ⧗2.4h')
    expect(chipLabel(usage({ costUsd: 123.45 }), H, 'cost', false)).toBe('$123')
    expect(chipLabel(usage({ costUsd: 123.45 }), H, 'time', false)).toBe('⧗2.4h')
    expect(chipLabel(null, null, 'both', false)).toBe('$ -- ⧗--')
    expect(chipLabel(null, null, 'time', false)).toBe('⧗--')
  })

  test('the cost rule: cents under $100, whole dollars from there, a floor from $100,000', () => {
    expect(formatUsdChip(99.99)).toBe('$99.99')
    expect(formatUsdChip(99.999)).toBe('$100')
    expect(formatUsdChip(100)).toBe('$100')
    expect(formatUsdChip(1234.4)).toBe('$1,234')
    expect(formatUsdChip(99_999.4)).toBe('$99,999')
    expect(formatUsdChip(250_000)).toBe('$100k+')
    expect(formatUsdChip(-5.5)).toBe('-$5.50')
    expect(formatUsdChip(null)).toBe('$ --')
  })

  test('chipContext appends · ctx N% once the fill is known', () => {
    expect(chipLabel(usage({ costUsd: 123.45, context: { tokens: 1, window: 10, percent: 12 } }), null, 'cost', true)).toBe('$123 · ctx 12%')
    expect(chipLabel(usage({ context: { tokens: 1, window: 10, percent: 12 } }), H, 'time', true)).toBe('⧗2.4h · ctx 12%')
    expect(chipLabel(usage({ context: { tokens: null, window: 10, percent: null } }), H, 'time', true)).toBe('⧗2.4h')
  })

  test('the label never passes 16 characters: the time gives way first, then the context', () => {
    // `$12.34 ⧗2.4h · ctx 42%` is 22: the time gives way.
    expect(chipLabel(usage(), H, 'both', true)).toBe('$12.34 · ctx 42%')
    // `$1,234 · ctx 100%` is 17: the context gives way and the time returns.
    expect(chipLabel(usage({ costUsd: 1234, context: { tokens: 10, window: 10, percent: 100 } }), H, 'both', true)).toBe('$1,234 ⧗2.4h')
    expect(chipLabel(usage({ context: { tokens: 10, window: 10, percent: 100 } }), 1e9, 'time', true)).toBe('⧗9999h+')
    for (const cost of [null, 0, 9.99, 99.99, 123.4, 99_999, 1e9])
      for (const today of [null, 0, H, 1e9])
        for (const mode of ['both', 'cost', 'time'] as const)
          for (const ctx of [true, false]) {
            const label = chipLabel(usage({ costUsd: cost, context: { tokens: 1, window: 1, percent: 100 } }), today, mode, ctx)
            expect([...label].length).toBeLessThanOrEqual(CHIP_MAX)
            expect(/\p{Extended_Pictographic}/u.test(label)).toBe(false)
          }
  })

  test('no cost ledger: the cost part is left out and the time stands in, so the chip never vanishes', () => {
    const none = usage({ costUsd: null, hasCost: false })
    expect(chipLabel(none, H, 'both', false)).toBe('⧗2.4h')
    expect(chipLabel(none, H, 'cost', false)).toBe('⧗2.4h')
  })
})

describe('the Usage pane lines (SPEC §6.6)', () => {
  test('a pair right-aligns its value in the label column model; a long value wraps under its label', () => {
    expect(pairLines('Cost', '$12.34', 100, 20)).toEqual([`  Cost${' '.repeat(16)}${' '.repeat(6)}$12.34`])
    const narrow = pairLines('5-hour', '23.5% · resets Tue 3:40 PM', 40, 14)
    expect(narrow).toEqual(['  5-hour', '    23.5% · resets Tue 3:40 PM'])
  })

  test('at 24 to 120 columns every line fits, no figure is cut, and the estimate column is never dropped', () => {
    for (const width of [24, 26, 28, 40, 60, 84, 120]) {
      const lines = usageLines(view(), width, '5m')
      for (const l of lines) {
        expect([...l.text].length).toBeLessThanOrEqual(width)
        expect(/[0-9$%,.kM]…$/.test(l.text)).toBe(false)
      }
      expect(lines.some(l => /^ {2}Model +.*Est\. \$/.test(l.text))).toBe(true)
    }
  })

  test('sections, in order, with the TTL-aware footnote', () => {
    const lines = usageLines(view(), 100, '5m')
    const titles = lines.filter(l => l.style === 'title').map(l => l.text)
    expect(titles).toEqual(['This session', 'Context', 'Rate limits', 'Models', "What's contributing", 'Code changes'])
    const texts = lines.map(l => l.text)
    expect(texts.some(t => /^ {2}Agent turns +1$/.test(t))).toBe(true)
    expect(texts.some(t => /^ {2}Window +84k of 200k \(42%\)$/.test(t))).toBe(true)
    expect(texts.some(t => /^ {2}Model +Req +Input +Output +Cache rd +Cache wr +Hit +Est\. \$ +Share$/.test(t))).toBe(true)
    expect(texts.some(t => /^ {2}Total /.test(t))).toBe(true)
    expect(texts).toContain('  main loop 93% · subagents 7%')
    expect(texts).toContain('  builder 7%')
    expect(texts).toContain('  +3 −1 lines · 1 edit')
    expect(texts.join(' ').replace(/\s+/g, ' ')).toContain('cache writes at 1.25× input under a 5-minute TTL, 2× under 1-hour, by the TTL in force, else the 5m option')
    expect(priceNote('1h')).toContain('else the 1h option')
    const bar = lines.find(l => l.style === 'bar')
    expect(bar && bar.style === 'bar' ? [bar.text.trim().length, bar.track.length] : null).toEqual([7, 9])
  })

  test('no ledger, no limits and no requests each say so', () => {
    const texts = usageLines(view({ usage: usage({ hasCost: false, costUsd: null }), models: {}, loops: { main: emptyCounts(), agents: {} } }), 80, '5m').map(l => l.text)
    expect(texts.some(t => /^ {2}Cost +no ledger here$/.test(t))).toBe(true)
    expect(texts).toContain('  none reported')
    expect(texts).toContain('  No requests counted yet.')
    expect(texts).toContain('  Nothing counted yet.')
  })

  test('columns drop by tier: medium keeps Output, Cache rd, Hit, Est. $, Share; narrow Output, Est. $, Share', () => {
    const head = (w: number) => usageLines(view(), w, '5m').find(l => /^ {2}Model /.test(l.text))?.text.split(/ {2,}/).map(s => s.trim()).filter(Boolean)
    expect(head(120)).toEqual(['Model', 'Req', 'Input', 'Output', 'Cache rd', 'Cache wr', 'Hit', 'Est. $', 'Share'])
    expect(head(70)).toEqual(['Model', 'Output', 'Cache rd', 'Hit', 'Est. $', 'Share'])
    expect(head(40)).toEqual(['Model', 'Output', 'Est. $', 'Share'])
  })

  test('at 24, 40, 60, 84 and 120 columns no line is longer than the pane, hostile names included', () => {
    const v = view({
      models: { [`claude-${HOSTILE}${'x'.repeat(80)}`]: counts({ requests: 1, output: 9, estUsd: 1 }), 'claude-opus-5-5': counts({ requests: 1, output: 9, estUsd: 1 }) },
      loops: { main: counts({ estUsd: 1 }), agents: { [oneLine(HOSTILE, 24)]: counts({ estUsd: 1 }) } },
      breakdown: breakdownFrom({ totalTokens: 1, rawMaxTokens: 10, isAutoCompactEnabled: true, autoCompactThreshold: 5, categories: [{ name: 'y'.repeat(40), kind: 'used', tokens: 1 }] }),
      usage: usage({ rateLimits: [{ kind: 'seven_day_opus_and_more', percentUsed: 99.5, resetsAt: '2026-10-20T15:40:00Z' }] }),
    })
    for (const w of [24, 40, 60, 84, 120]) {
      for (const l of usageLines(v, w, '1h')) {
        const whole = l.style === 'bar' ? l.text + l.track : l.text
        if ([...whole].length > w) throw new Error(`${w}: ${JSON.stringify(whole)}`)
        expect(whole).not.toMatch(/[\n\u001b‮]/)
      }
    }
  })
})
