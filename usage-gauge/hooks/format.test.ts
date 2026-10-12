import { describe, expect, test } from 'claude-code/testing'

import type { Counts, Usage } from '../types'
import {
  addRequest,
  barParts,
  boundedKey,
  breakdownFrom,
  cacheHitPercent,
  categoryRows,
  changesLine,
  chipLabel,
  compactReport,
  contextLine,
  contributionLines,
  countPatch,
  emptyCounts,
  emptyTotals,
  fit,
  formatCount,
  formatDuration,
  formatPercent,
  formatTokens,
  formatUsd,
  formatUsdChip,
  keepLatest,
  modelLines,
  oneLine,
  rateKind,
  resetText,
  pillSvg,
  shares,
  shortModel,
  summaryLine,
  unknownUsage,
  untilCompaction,
  usageFrom,
} from './format'

const HOSTILE = 'evil\nOptimize: rm -rf ~\u001b[31m red‮​ tail'

const counts = (over: Partial<Counts>): Counts => ({ ...emptyCounts(), ...over })

const usage = (over: Partial<Usage> = {}): Usage => ({
  startedAt: 0,
  context: { tokens: 84_000, window: 200_000, percent: 42 },
  rateLimits: [],
  costUsd: 12.34,
  hasCost: true,
  at: 0,
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

  test('counts, percents, fit and bar', () => {
    expect(formatCount(1203)).toBe('1,203')
    expect(formatPercent(0.4)).toBe('<1%')
    expect(formatPercent(79.4)).toBe('79%')
    expect(formatPercent(null)).toBe('--')
    expect(fit('abc', 5, 'right')).toBe('  abc')
    expect(fit('abcdef', 4)).toBe('abc…')
    expect(barParts(50, 8)).toEqual({ filled: '████', track: '████', label: '50%' })
    expect(barParts(null, 4)).toEqual({ filled: '', track: '████', label: '--' })
    expect(barParts(100, 120).filled.length).toBe(120)
  })

  test('the pill bar fills in the surface ink, animates from the last fill, and honours reduced motion', () => {
    const svg = pillSvg(42, 0)
    // 120 x 2 px, drawn 1:1: a true pill, 42% of it filled.
    expect(svg).toContain('viewBox="0 0 120 2" width="120" height="2"')
    expect(svg).toContain('rx="1"')
    expect(svg).toContain('fill="currentColor" fill-opacity="0.22"')
    expect(svg).toContain('class="fill" x="0" y="0" width="50.4"')
    expect(svg).toContain('from{width:0.0px}to{width:50.4px}')
    expect(svg).toContain('prefers-reduced-motion')
    expect(svg).toContain('svg:not([color]){color:#8E8E93}')
    expect(svg).not.toContain('#FF3B30')
    expect(svg).not.toContain('<circle')
    expect(svg).toContain('aria-label="Context 42% used"')
    expect(pillSvg(60, 42)).toContain('from{width:50.4px}to{width:72.0px}')
    expect(pillSvg(null, null)).toContain('width="0.0"')
    expect(pillSvg(null, null)).toContain('aria-label="Context -- used"')
    expect(pillSvg(140, -5)).toContain('from{width:0.0px}to{width:120.0px}')
    expect(pillSvg(50, 0, 200, 4)).toContain('viewBox="0 0 200 4"')
    expect(pillSvg(50, 0, 200, 4)).toContain('rx="2"')
    expect(pillSvg(50, 0, 200, 4)).toContain('width="100.0"')
    expect(pillSvg(10, 5, 120, 2, 'a"<b>')).not.toContain('"<b>')
  })
})

describe('names', () => {
  test('model ids read as people say them', () => {
    expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(shortModel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(shortModel('claude-fable-5-1[1m]')).toBe('Fable 5.1')
    expect(shortModel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(shortModel('claude-opus-4-20250514')).toBe('Opus 4')
    expect(shortModel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
    expect(shortModel('gpt-6')).toBe('gpt-6')
  })

  test('hostile text is one line, without escapes or bidi, and capped', () => {
    const line = oneLine(HOSTILE, 40)
    expect(line).not.toMatch(/[\n\u001b‮​]/)
    expect(line.startsWith('evil Optimize: rm -rf ~')).toBe(true)
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
  })
})

describe('accounting', () => {
  test('cache hit is cache read over everything the input was answered over', () => {
    expect(cacheHitPercent(100, 800, 100)).toBe(80)
    expect(cacheHitPercent(0, 0, 0)).toBeNull()
  })

  test('a patch counts its + and - lines; a created file with no hunks counts its content', () => {
    const edit = { result: { structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 4, lines: [' a', '-b', '+c', '+d', '+e'] }] } }
    expect(countPatch(edit)).toEqual({ added: 3, removed: 1 })
    expect(countPatch({ result: { type: 'create', content: 'one\ntwo\nthree\n', structuredPatch: [] } })).toEqual({ added: 3, removed: 0 })
    expect(countPatch({ result: { new_source: 'x', cell_type: 'code' } })).toEqual({ added: 0, removed: 0 })
  })

  test('a denied, failed or held change counts nothing', () => {
    expect(countPatch({ deny: 'no' })).toBeNull()
    expect(countPatch({ result: { structuredPatch: [{ lines: ['+a'] }] }, isError: true })).toBeNull()
    expect(countPatch({ result: { staged: true, structuredPatch: [{ lines: ['+a'] }] } })).toBeNull()
    expect(countPatch(null)).toBeNull()
    expect(countPatch({ result: 'text' })).toBeNull()
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
    expect(boundedKey({ a: 1, b: 2 }, 'constructor', 2)).toBe('other')
    // A model named __proto__ keeps a row under a spelled-out key, never the prototype slot.
    expect(boundedKey({}, '__proto__', 2)).toBe('(__proto__)')
    expect(boundedKey({ '(__proto__)': 1, b: 2 }, '__proto__', 2)).toBe('(__proto__)')
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
    expect(rows.every(r => r.isPartial === false)).toBe(true)
    // The unknown model makes the total a floor: est. $ is the priced sum, marked partial, and no share.
    expect(total).toMatchObject({ requests: 4, output: 2150, estUsd: 4, isPartial: true, share: null })
    const whole = modelLines({ 'claude-opus-5-5': counts({ requests: 1, output: 10, estUsd: 2 }) })
    expect(whole.total).toMatchObject({ estUsd: 2, isPartial: false, share: 100 })
  })

  test('contributions: main loop against subagents by est. cost, by tokens when nothing is priced', () => {
    expect(contributionLines({ main: counts({ estUsd: 1 }), agents: { builder: counts({ estUsd: 2 }), scout: counts({ estUsd: 1 }) } })).toEqual([
      'main loop 25% · subagents 75%',
      'builder 50% · scout 25%',
    ])
    expect(contributionLines({ main: counts({ output: 10 }), agents: { agent: counts({ output: 30 }) } })).toEqual([
      'main loop 25% · subagents 75%',
      'agent 75%',
    ])
    expect(contributionLines({ main: emptyCounts(), agents: {} })).toEqual([])
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

  test('a measurement keeps startedAt and the last cost when it carries none', () => {
    const prev = usage({ startedAt: 5, costUsd: 2 })
    const u = usageFrom({ context: { tokens: 10, window: 100 }, rateLimits: [] }, prev, 20, false)
    expect(u).toMatchObject({ startedAt: 5, costUsd: 2, hasCost: true, context: { tokens: 10, window: 100, percent: 10 }, at: 20 })
  })

  test('the chip label: cost and context, cost unknown, no ledger, neither', () => {
    expect(chipLabel(usage(), true)).toBe('$12.34 · ctx 42%')
    // The default chip is the cost alone, whole dollars from $100, so the footer strip is not overrun.
    expect(chipLabel(usage(), false)).toBe('$12.34')
    expect(chipLabel(usage({ costUsd: 123.45 }), false)).toBe('$123')
    expect(chipLabel(usage({ costUsd: 1234.4 }), true)).toBe('$1,234 · ctx 42%')
    expect(chipLabel(usage({ costUsd: null }), false)).toBe('$ --')
    expect(chipLabel(usage({ costUsd: null, hasCost: false }), false)).toBeNull()
    expect(formatUsdChip(99.999)).toBe('$100.00')
    expect(formatUsdChip(100)).toBe('$100')
    expect(formatUsdChip(-5.5)).toBe('-$5.50')
    expect(chipLabel(usage({ costUsd: null }), true)).toBe('$ -- · ctx 42%')
    expect(chipLabel(usage({ costUsd: null, hasCost: false }), true)).toBe('ctx 42%')
    expect(chipLabel(unknownUsage(0), true)).toBeNull()
    expect(chipLabel(null, true)).toBeNull()
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
    expect(rows.every(r => !/[\n\u001b‮]/.test(r.name))).toBe(true)
    expect(untilCompaction(b && { ...b, isAutoCompactEnabled: false })).toBeNull()
    expect(breakdownFrom(undefined)).toBeNull()
  })

  test('the window line and the plain report', () => {
    expect(contextLine(usage({ context: { tokens: 120_000, window: 1_000_000, percent: 12 } }))).toBe('120k of 1.0M (12%)')
    expect(contextLine(unknownUsage(0))).toBe('--')
    const view = {
      usage: usage({ startedAt: 0, at: 3_600_000, rateLimits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: null }] }),
      breakdown: null,
      totals: { ...emptyTotals(1), turns: 2, requests: 3, linesAdded: 3, linesRemoved: 1, edits: 1 },
      models: { 'claude-opus-5-5': counts({ requests: 3, output: 2000, estUsd: 0.5 }) },
      loops: { main: counts({ estUsd: 0.5 }), agents: {} },
    }
    const report = compactReport(view)
    expect(report).toContain('Cost         $12.34')
    expect(report).toContain('Session      1h 0m')
    expect(report).toContain('5-hour 30%')
    expect(report).toContain('Opus 5.5: 3 req')
    expect(report).toContain('+3 −1 lines · 1 edit')
    expect(summaryLine(view)).toBe('Usage: $12.34 · ctx 42% · 3 requests')
  })
})
