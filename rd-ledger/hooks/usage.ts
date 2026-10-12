// rd-ledger: the Usage pane's accounting and drawing (SPEC §6.6), ported from
// the usage-gauge mod, which this pane supersedes. Pure: nothing here touches
// `$`, every instant comes from the caller, so all of it is tested in
// usage.test.ts.
//
// What changed from usage-gauge: estimates price through this mod's own
// `priceRow` (one table, not a copy) with the cache-write multiplier of the TTL
// in force when the request ran (usage-gauge's was a fixed 1.25); the pane is
// drawn as lines fitted to the pane's width with report.ts's helpers (B1's
// width model), the context bar is text on every surface (no Svg); a text
// answer is the one summary line only (counts, never a model or agent name).

import type { Breakdown, CategoryRow, RateLimitRow, Usage, UsageCounts, UsageTotals } from '../types'
import { CACHE_WRITE_MULTIPLIER, PRICES_AS_OF, priceRow } from './prices'
import { fit, fitTable, footerLabel, pairLines, tierOf, wrapText } from './report'
import type { Col, ViewLine } from './report'
import { oneLine } from './text'

/** Caps on drawn text, so nothing an id or a name holds can widen a row past these. */
export const UCAP = { model: 32, agentType: 24, category: 40, rateKind: 24 } as const

/** Distinct models and agent types kept apart (any more fold into `other`), agent ids remembered, category rows drawn. */
export const MAX_MODELS = 50
export const MAX_AGENT_TYPES = 50
export const MAX_AGENT_IDS = 500
export const MAX_CATEGORIES = 8

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const len = (s: string): number => [...s].length

/** A whole count with thousands separators: `1,203`. */
export const formatCount = (n: number): string => (isNum(n) ? `${n < 0 ? '-' : ''}${group(String(Math.round(Math.abs(n))))}` : '--')

/** Dollars with two decimals and thousands separators (`$123.45`, `$1,204.10`); `$ --` when unknown. */
export function formatUsd(usd: number | null): string {
  if (usd === null || !isNum(usd)) return '$ --'
  const [whole = '0', cents = '00'] = Math.abs(usd).toFixed(2).split('.')
  return `${usd < 0 ? '-' : ''}$${group(whole)}.${cents}`
}

/**
 * The chip's dollars, as short as the footer strip needs: cents under $100
 * (`$12.34`), whole dollars from there (`$123`, `$1,234`), a floor from
 * $100,000 (`$100k+`), so the figure is never more than seven characters;
 * `$ --` unknown.
 */
export function formatUsdChip(usd: number | null): string {
  if (usd === null || !isNum(usd)) return '$ --'
  const sign = usd < 0 ? '-' : ''
  const abs = Math.abs(usd)
  if (abs < 99.995) return formatUsd(usd)
  if (abs >= 99_999.5) return `${sign}$100k+`
  return `${sign}$${group(String(Math.round(abs)))}`
}

/** Tokens, short: `572`, `345.3k`, `152.3M`; `digits` is the decimals under a million (`152k` with 0). */
export function formatTokens(n: number | null, digits = 1): string {
  if (n === null || !isNum(n)) return '--'
  const abs = Math.max(0, n)
  if (abs < 1000) return String(Math.round(abs))
  const k = (abs / 1000).toFixed(digits)
  if (Number(k) < 1000) return `${k}k`
  return `${(abs / 1_000_000).toFixed(1)}M`
}

/** `4s`, `8m 4s`, `2h 14m`, `31h 24m`; `--` when unknown or negative. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !isNum(ms) || ms < 0) return '--'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** A share as a whole percent; a positive share under one percent reads `<1%`. */
export const formatPercent = (p: number | null): string => (p === null || !isNum(p) ? '--' : p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`)

/** The context bar as text: a run of filled cells and a run of track cells (the pane draws the track dim; no hatching). */
export function barParts(percent: number | null, width: number): { filled: string; track: string; label: string } {
  const cells = Math.max(4, Math.floor(width))
  if (percent === null || !isNum(percent)) return { filled: '', track: '█'.repeat(cells), label: '--' }
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * cells)
  return { filled: '█'.repeat(filled), track: '█'.repeat(cells - filled), label: `${Math.round(percent)}%` }
}
/** The bar's cells at most. */
export const BAR_CELLS = 16

const capital = (word: string): string => (word ? word[0]?.toUpperCase() + word.slice(1) : word)

/**
 * A model id as people say it: `claude-opus-5-5` -> `Opus 5.5`,
 * `claude-fable-5-1[1m]` -> `Fable 5.1`, `claude-3-5-sonnet-20241022` ->
 * `Sonnet 3.5`. Anything else is the id without `claude-`, as one capped line.
 */
export function shortModel(model: string): string {
  const id = oneLine(model, 120).toLowerCase()
  const named = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/.exec(id)
  if (named?.[1] && named[2]) return oneLine(`${capital(named[1])} ${named[2]}${named[3] ? `.${named[3]}` : ''}`, UCAP.model)
  const legacy = /^claude-(\d{1,2})(?:-(\d{1,2}))?-([a-z]+)/.exec(id)
  if (legacy?.[1] && legacy[3]) return oneLine(`${capital(legacy[3])} ${legacy[1]}${legacy[2] ? `.${legacy[2]}` : ''}`, UCAP.model)
  return oneLine(model.replace(/^claude-/, ''), UCAP.model) || '?'
}

/** Cache read over everything the requests were answered over, as a percent; null with no input at all. */
export function cacheHitPercent(input: number, cacheRead: number, cacheWrite: number): number | null {
  const total = Math.max(0, input) + Math.max(0, cacheRead) + Math.max(0, cacheWrite)
  return total > 0 ? (Math.max(0, cacheRead) / total) * 100 : null
}

/**
 * One request's list-price estimate in USD, or null when the price table does
 * not know the model. Cache writes are priced at the multiplier of `ttl`, the
 * TTL in force when the request ran (SPEC §5), not a fixed 1.25.
 */
export function estimateUsd(model: string, c: { input: number; output: number; cacheRead: number; cacheWrite: number }, ttl: '5m' | '1h'): number | null {
  const row = priceRow(model)
  if (!row) return null
  const n = (v: number) => (isNum(v) && v > 0 ? v : 0)
  const cw = row.input * CACHE_WRITE_MULTIPLIER[ttl === '1h' ? '1h' : '5m']
  return (n(c.input) * row.input + n(c.output) * row.output + n(c.cacheRead) * row.cacheRead + n(c.cacheWrite) * cw) / 1_000_000
}

const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0))

/**
 * The lines one Edit / Write / NotebookEdit call changed, from its result's
 * `structuredPatch` hunks (`+` lines added, `-` removed); a Write that created
 * a file with no hunks counts its content's lines. Null (count nothing) for a
 * denied call, an error result, or a change held for review (`staged`). Only
 * counts leave this function: no path and no line text is returned or kept.
 */
export function countPatch(ran: unknown): { added: number; removed: number } | null {
  if (!ran || typeof ran !== 'object') return null
  const o = ran as Record<string, unknown>
  // A NotebookEdit failure can carry `error` without `isError`; either one means nothing changed.
  if (typeof o['deny'] === 'string' || o['isError'] === true || (o['error'] !== undefined && o['error'] !== null && o['error'] !== false)) return null
  const result = o['result']
  if (!result || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  if (r['staged'] === true) return null
  let added = 0
  let removed = 0
  const hunks = Array.isArray(r['structuredPatch']) ? (r['structuredPatch'] as unknown[]) : []
  for (const hunk of hunks) {
    const lines = hunk && typeof hunk === 'object' ? (hunk as Record<string, unknown>)['lines'] : null
    if (!Array.isArray(lines)) continue
    for (const line of lines) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  if (hunks.length === 0 && r['type'] === 'create' && typeof r['content'] === 'string') added = lineCount(r['content'])
  return { added, removed }
}

/** Each entry's share of the positive total, biggest first; empty when the total is zero. */
export function shares(entries: readonly (readonly [string, number])[]): { key: string; percent: number }[] {
  const positive = entries.filter(([, v]) => isNum(v) && v > 0)
  const total = positive.reduce((sum, [, v]) => sum + v, 0)
  if (total <= 0) return []
  return positive.map(([key, v]) => ({ key, percent: (v / total) * 100 })).sort((a, b) => b.percent - a.percent)
}

export const emptyCounts = (): UsageCounts => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, apiMs: 0, estUsd: 0, unpriced: 0 })

export const emptyTotals = (loadedAt = 0): UsageTotals => ({
  loadedAt,
  updatedAt: loadedAt,
  turns: 0,
  agentTurns: 0,
  requests: 0,
  activeMs: 0,
  apiMs: 0,
  linesAdded: 0,
  linesRemoved: 0,
  edits: 0,
})

const tokensOf = (c: UsageCounts): number => c.input + c.output + c.cacheRead + c.cacheWrite

/** One request added to a row: its four counts, its wall time and its estimate (null: unpriced). */
export function addRequest(
  row: UsageCounts | undefined,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null,
  apiMs: number,
  estUsd: number | null,
): UsageCounts {
  const c = { ...emptyCounts(), ...row }
  const n = (v: number) => (isNum(v) && v > 0 ? v : 0)
  c.requests += 1
  c.apiMs += n(apiMs)
  if (usage) {
    c.input += n(usage.input)
    c.output += n(usage.output)
    c.cacheRead += n(usage.cacheRead)
    c.cacheWrite += n(usage.cacheWrite)
  }
  if (estUsd === null) c.unpriced += 1
  else c.estUsd += n(estUsd)
  return c
}

/** The record's own value at `key` (never one inherited, so a model named `constructor` is just a model). */
export const ownGet = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined

/** A record keyed by `key` with at most `max` keys: a new key past the cap folds into `other`. */
export function boundedKey(record: Readonly<Record<string, unknown>>, key: string, max: number): string {
  // `__proto__` as a computed key is an own property here, but it does not survive the
  // state's JSON round-trip as one, so that one name is spelled out instead.
  const safe = key === '__proto__' ? '(__proto__)' : key
  return ownGet(record, safe) !== undefined || Object.keys(record).length < max ? safe : 'other'
}

/** The latest `max` entries of an insertion-ordered record. */
export function keepLatest<T>(record: Readonly<Record<string, T>>, max: number): Record<string, T> {
  const entries = Object.entries(record)
  return entries.length <= max ? { ...record } : Object.fromEntries(entries.slice(entries.length - max))
}

/** A rate-limit window's kind spelled out: `5-hour`, `7-day`, `spend limit`. */
export function rateKind(kind: string): string {
  return (
    oneLine(kind, UCAP.rateKind)
      .toLowerCase()
      .replace(/^five_hour/, '5-hour')
      .replace(/^seven_day/, '7-day')
      .replace(/_/g, ' ') || 'limit'
  )
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** When a window resets, in local time: `3:40 PM` within a day, `Tue 3:40 PM` past it; null when unreadable. */
export function resetText(iso: string | null, now: number): string | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (!isNum(at)) return null
  const d = new Date(at)
  const h = d.getHours()
  const time = `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
  return at - now < 24 * 60 * 60_000 ? time : `${WEEKDAYS[d.getDay()] ?? ''} ${time}`.trim()
}

/** One rate-limit row: `5-hour` and `23.5% · resets 3:40 PM`. */
export function rateLine(r: RateLimitRow, now: number): { label: string; value: string } {
  const reset = resetText(r.resetsAt, now)
  const pct = isNum(r.percentUsed) ? Math.round(r.percentUsed * 10) / 10 : 0
  return { label: rateKind(r.kind), value: `${pct}%${reset ? ` · resets ${reset}` : ''}` }
}

/** What a usage reading or a measurement holds, as the engine gives it (never any text field). */
export type Reading = {
  startedAt?: unknown
  context?: { tokens?: unknown; window?: unknown; percent?: unknown } | null
  rateLimits?: readonly { kind?: unknown; percentUsed?: unknown; resetsAt?: unknown }[] | null
  cost?: { usd?: unknown } | null
}

const numOrNull = (v: unknown): number | null => (isNum(v) ? v : null)

/**
 * The `usage` atom from a reading. `isFull` is `$.session.usage()` (its
 * missing cost means the host keeps no ledger); a `session.measure` reading
 * keeps the last cost when it carries none, and keeps `startedAt` always.
 */
export function usageFrom(r: Reading, prev: Usage | null, at: number, isFull: boolean): Usage {
  const ctx = r.context ?? {}
  const tokens = numOrNull(ctx.tokens)
  const window = numOrNull(ctx.window)
  let percent = numOrNull(ctx.percent)
  if (percent === null && tokens !== null && window !== null && window > 0) percent = (tokens / window) * 100
  const rateLimits: RateLimitRow[] = []
  for (const row of (Array.isArray(r.rateLimits) ? r.rateLimits : []).slice(0, 8)) {
    if (!row || typeof row.kind !== 'string' || !isNum(row.percentUsed)) continue
    const resetsAt = typeof row.resetsAt === 'string' && row.resetsAt.length <= 64 ? row.resetsAt : null
    rateLimits.push({ kind: oneLine(row.kind, UCAP.rateKind), percentUsed: row.percentUsed, resetsAt })
  }
  const usd = r.cost && typeof r.cost === 'object' ? numOrNull(r.cost.usd) : null
  const costUsd = usd !== null ? usd : isFull ? null : (prev?.costUsd ?? null)
  const hasCost = usd !== null ? true : isFull ? false : (prev?.hasCost ?? true)
  return {
    startedAt: isFull ? numOrNull(r.startedAt) : (prev?.startedAt ?? null),
    context: { tokens, window, percent },
    rateLimits,
    costUsd,
    hasCost,
    at,
  }
}

/** The usage atom when the figures cannot be read: every figure unknown, so the pane draws `--`. */
export const unknownUsage = (at: number): Usage => ({
  startedAt: null,
  context: { tokens: null, window: null, percent: null },
  rateLimits: [],
  costUsd: null,
  hasCost: true,
  at,
})

const KINDS: readonly CategoryRow['kind'][] = ['used', 'free', 'buffer', 'deferred']

/** The breakdown atom from `context.breakdown`, names made one line; null when it is not one. */
export function breakdownFrom(raw: unknown): Breakdown | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  if (!isNum(b['totalTokens']) || !isNum(b['rawMaxTokens'])) return null
  const categories: CategoryRow[] = []
  for (const c of (Array.isArray(b['categories']) ? (b['categories'] as unknown[]) : []).slice(0, 40)) {
    if (!c || typeof c !== 'object') continue
    const row = c as Record<string, unknown>
    if (typeof row['name'] !== 'string' || !isNum(row['tokens'])) continue
    const kind = KINDS.includes(row['kind'] as CategoryRow['kind']) ? (row['kind'] as CategoryRow['kind']) : 'used'
    categories.push({ name: oneLine(row['name'], UCAP.category) || '?', kind, tokens: Math.max(0, row['tokens']) })
  }
  return {
    totalTokens: b['totalTokens'],
    rawMaxTokens: b['rawMaxTokens'],
    percentage: isNum(b['percentage']) ? b['percentage'] : 0,
    autoCompactThreshold: numOrNull(b['autoCompactThreshold']),
    isAutoCompactEnabled: b['isAutoCompactEnabled'] === true,
    model: typeof b['model'] === 'string' ? oneLine(b['model'], UCAP.model) : '',
    categories,
  }
}

/** The footer chip's content (SPEC §6.5, option `footerChip`). */
export type ChipMode = 'both' | 'cost' | 'time'
/** The chip label never grows past this many characters. */
export const CHIP_MAX = 16

/**
 * The footer chip: `both` draws `$123 ⧗2.4h` (the session cost by the chip
 * rule, then today's R&D hours by footerLabel), `cost` `$123`, `time` `⧗2.4h`;
 * `withContext` appends ` · ctx 12%` once the fill is known. The cost part is
 * left out where the host keeps no cost ledger (the time part then stands in,
 * so the chip never vanishes). Past CHIP_MAX characters the time part gives
 * way first (when a cost remains), then the context, so the label is at most
 * 16 characters and the strip never clips it (cost and time are at most 8
 * each, `-$99,999` and `⧗9999.9h`, so the pair alone can need the fallback).
 */
export function chipLabel(usage: Usage | null, todayS: number | null, mode: ChipMode, withContext: boolean): string {
  const time = footerLabel(todayS)
  const cost = mode !== 'time' && (usage === null || usage.hasCost) ? formatUsdChip(usage?.costUsd ?? null) : null
  const showTime = mode !== 'cost' || cost === null
  const pct = usage?.context.percent
  const ctx = withContext && isNum(pct) ? `ctx ${Math.round(pct)}%` : null
  const build = (withTime: boolean, withCtx: boolean): string => {
    const head = [cost, withTime || cost === null ? time : null].filter(Boolean).join(' ')
    return withCtx && ctx ? `${head} · ${ctx}` : head
  }
  for (const [t, c] of [[showTime, true], [cost === null, true], [showTime, false], [cost === null, false]] as const) {
    const label = build(t, c)
    if (len(label) <= CHIP_MAX) return label
  }
  return fit(build(false, false), CHIP_MAX)
}

/** `120k of 1.0M (12%)`; `--` before any reading. */
export function contextLine(usage: Usage | null): string {
  const c = usage?.context
  if (!c || (c.tokens === null && c.window === null)) return '--'
  return `${formatTokens(c.tokens, 0)} of ${formatTokens(c.window, 0)} (${c.percent === null ? '--' : `${Math.round(c.percent)}%`})`
}

/** Tokens left before auto-compaction runs; null when it is off or the threshold is unknown. */
export function untilCompaction(b: Breakdown | null): number | null {
  if (!b || !b.isAutoCompactEnabled || b.autoCompactThreshold === null) return null
  return Math.max(0, b.autoCompactThreshold - b.totalTokens)
}

/** Up to `max` category rows: what is used, biggest first, then free space and the buffer, dim. */
export function categoryRows(b: Breakdown | null, max = MAX_CATEGORIES): { name: string; tokens: number; percent: number | null; isDim: boolean }[] {
  if (!b) return []
  const rank = (c: CategoryRow) => (c.kind === 'used' ? 0 : 1)
  return [...b.categories]
    .sort((x, y) => rank(x) - rank(y) || y.tokens - x.tokens)
    .slice(0, max)
    .map(c => ({ name: c.name, tokens: c.tokens, percent: b.rawMaxTokens > 0 ? (c.tokens / b.rawMaxTokens) * 100 : null, isDim: c.kind !== 'used' }))
}

export type ModelLine = {
  model: string
  name: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  hit: number | null
  /** Null when the price table does not know the model. */
  estUsd: number | null
  /** Of the priced total; null when unpriced. */
  share: number | null
  /** True on a total that leaves an unpriced model out: its est. $ is a floor, its share unknown. */
  isPartial: boolean
}

/** The model rows, the priciest first, and their total. */
export function modelLines(models: Readonly<Record<string, UsageCounts>>): { rows: ModelLine[]; total: ModelLine } {
  const entries = Object.entries(models)
  const priced = entries.reduce((sum, [, c]) => sum + (c.unpriced > 0 ? 0 : c.estUsd), 0)
  const rows = entries.map(([model, c]): ModelLine => {
    const estUsd = c.unpriced > 0 ? null : c.estUsd
    return {
      model,
      name: shortModel(model),
      requests: c.requests,
      input: c.input,
      output: c.output,
      cacheRead: c.cacheRead,
      cacheWrite: c.cacheWrite,
      hit: cacheHitPercent(c.input, c.cacheRead, c.cacheWrite),
      estUsd,
      share: estUsd !== null && priced > 0 ? (estUsd / priced) * 100 : null,
      isPartial: false,
    }
  })
  rows.sort((a, b) => (b.estUsd ?? -1) - (a.estUsd ?? -1) || b.output - a.output)
  const sum = (f: (l: ModelLine) => number) => rows.reduce((s, l) => s + f(l), 0)
  const isPartial = rows.some(l => l.estUsd === null)
  const total: ModelLine = {
    model: 'total',
    name: 'Total',
    requests: sum(l => l.requests),
    input: sum(l => l.input),
    output: sum(l => l.output),
    cacheRead: sum(l => l.cacheRead),
    cacheWrite: sum(l => l.cacheWrite),
    hit: cacheHitPercent(sum(l => l.input), sum(l => l.cacheRead), sum(l => l.cacheWrite)),
    estUsd: priced > 0 || rows.some(l => l.estUsd !== null) ? priced : null,
    share: priced > 0 && !isPartial ? 100 : null,
    isPartial,
  }
  return { rows, total }
}

export type Loops = { main: UsageCounts; agents: Readonly<Record<string, UsageCounts>> }

/** Main loop against subagents, and the top five subagent types, by est. cost (by tokens when nothing is priced). */
export function contributions(loops: Loops): { basis: 'cost' | 'tokens'; main: number; agents: number; types: { key: string; percent: number }[] } | null {
  const agents = Object.entries(loops.agents)
  const isCost = loops.main.estUsd + agents.reduce((s, [, c]) => s + c.estUsd, 0) > 0
  const of = (c: UsageCounts) => (isCost ? c.estUsd : tokensOf(c))
  const all = shares([['main', of(loops.main)], ...agents.map(([type, c]): [string, number] => [`agent:${type}`, of(c)])])
  if (all.length === 0) return null
  const main = all.find(s => s.key === 'main')?.percent ?? 0
  const types = all.filter(s => s.key.startsWith('agent:')).map(s => ({ key: s.key.slice(6), percent: s.percent }))
  return { basis: isCost ? 'cost' : 'tokens', main, agents: 100 - main, types: types.slice(0, 5) }
}

/** `main loop 40% · subagents 60%`, and `builder 35% · verifier 15%`. */
export function contributionLines(loops: Loops): string[] {
  const c = contributions(loops)
  if (!c) return []
  const lines = [`main loop ${formatPercent(c.main)} · subagents ${formatPercent(c.agents)}`]
  if (c.types.length > 0) lines.push(c.types.map(t => `${oneLine(t.key, UCAP.agentType)} ${formatPercent(t.percent)}`).join(' · '))
  return lines
}

/** `+4,321 −321 lines · 42 edits`. */
export const changesLine = (t: UsageTotals): string =>
  `+${formatCount(t.linesAdded)} −${formatCount(t.linesRemoved)} lines · ${formatCount(t.edits)} edit${t.edits === 1 ? '' : 's'}`

/** The price footnote: the table's date and the TTL rule the estimates followed. */
export const priceNote = (defaultTtl: '5m' | '1h'): string =>
  `Estimates at list price (as of ${PRICES_AS_OF}; cache writes at ${CACHE_WRITE_MULTIPLIER['5m']}× input under a 5-minute TTL, ${CACHE_WRITE_MULTIPLIER['1h']}× under 1-hour, by the TTL in force, else the ${defaultTtl} option); the headline cost is the engine's own ledger.`

/** Everything the Usage pane and its text answer draw, read from $.state. */
export type UsageView = {
  usage: Usage | null
  breakdown: Breakdown | null
  totals: UsageTotals
  models: Readonly<Record<string, UsageCounts>>
  loops: Loops
}

/** The latest moment the state knows of: the pane's "now", so drawing makes no clock call. */
export const viewNow = (v: UsageView): number => Math.max(v.usage?.at ?? 0, v.totals.updatedAt, v.totals.loadedAt)

/** How long the session has run, from the engine's start to the latest reading. */
export const sessionMs = (v: UsageView): number | null => (v.usage?.startedAt == null ? null : Math.max(0, viewNow(v) - v.usage.startedAt))

/** The one-line text answer (headless, or any origin that is not the person): cost, context and requests, counts only. */
export function usageSummaryLine(v: UsageView): string {
  const parts = [v.usage && !v.usage.hasCost ? 'no cost ledger' : formatUsd(v.usage?.costUsd ?? null)]
  if (v.usage?.context.percent != null && isNum(v.usage.context.percent)) parts.push(`ctx ${Math.round(v.usage.context.percent)}%`)
  parts.push(`${formatCount(v.totals.requests)} request${v.totals.requests === 1 ? '' : 's'}`)
  return `Usage: ${parts.join(' · ')}`
}

/** One drawn line of the Usage pane: B1's ViewLine, plus the context bar (filled cells, then the dim track). */
export type UsageLine = ViewLine | { text: string; style: 'bar'; track: string }

/** The pair helper is report.ts's, shared with the Session view: label and value are never cut; a pair that cannot share a line stacks. */
export { pairLines } from './report'

/** The model table's columns, dropped by the pane's tier (SPEC §6.6). */
const MODEL_COLS: { key: string; col: Col; value: (l: ModelLine) => string; tiers: readonly string[] }[] = [
  { key: 'req', col: { head: 'Req', align: 'r', drop: 1 }, value: l => formatCount(l.requests), tiers: ['wide'] },
  { key: 'in', col: { head: 'Input', align: 'r', drop: 2 }, value: l => formatTokens(l.input), tiers: ['wide'] },
  { key: 'out', col: { head: 'Output', align: 'r', drop: 6 }, value: l => formatTokens(l.output), tiers: ['wide', 'medium', 'narrow'] },
  { key: 'cr', col: { head: 'Cache rd', align: 'r', drop: 4 }, value: l => formatTokens(l.cacheRead), tiers: ['wide', 'medium'] },
  { key: 'cw', col: { head: 'Cache wr', align: 'r', drop: 3 }, value: l => formatTokens(l.cacheWrite), tiers: ['wide'] },
  { key: 'hit', col: { head: 'Hit', align: 'r', drop: 5 }, value: l => formatPercent(l.hit), tiers: ['wide', 'medium'] },
  // A total with an unpriced model in it is a floor, marked `+`, never a complete figure.
  { key: 'est', col: { head: 'Est. $', align: 'r' }, value: l => (l.estUsd === null ? '--' : `${formatUsd(l.estUsd)}${l.isPartial ? '+' : ''}`), tiers: ['wide', 'medium', 'narrow'] },
  { key: 'share', col: { head: 'Share', align: 'r', drop: 7 }, value: l => (l.share === null ? '--' : formatPercent(l.share)), tiers: ['wide', 'medium', 'narrow'] },
]

/**
 * The Usage pane as lines fitted to `width` (B1's model: no line longer than
 * the pane, tables through fitTable, free text through wrapText): this
 * session's headline pairs, Context (bar, window, until compaction, up to 8
 * categories), Rate limits, Models, What's contributing, Code changes, then
 * the caption. Drawn from the state alone.
 */
export function usageLines(v: UsageView, width: number, defaultTtl: '5m' | '1h'): UsageLine[] {
  const w = Math.max(24, Math.floor(isNum(width) ? width : 80))
  const tier = tierOf(w)
  const labelWidth = tier === 'narrow' ? 14 : 20
  const out: UsageLine[] = []
  const title = (text: string) => out.push({ text: fit(text, w), style: 'title' })
  const body = (text: string) => out.push({ text, style: 'body' })
  const dim = (text: string) => out.push({ text, style: 'dim' })
  const blank = () => out.push({ text: '', style: 'body' })
  const pair = (label: string, value: string, isDim = false) => pairLines(label, value, w, labelWidth).forEach(isDim ? dim : body)
  const t = v.totals
  const now = viewNow(v)

  title('This session')
  if (v.usage && !v.usage.hasCost) pair('Cost', 'no ledger here', true)
  else pair('Cost', formatUsd(v.usage?.costUsd ?? null))
  pair('Session', formatDuration(sessionMs(v)))
  pair('Active', formatDuration(t.activeMs))
  pair('API', formatDuration(t.apiMs))
  pair('Turns', formatCount(t.turns))
  pair('Requests', formatCount(t.requests))
  if (t.agentTurns > 0) pair('Agent turns', formatCount(t.agentTurns))

  blank()
  title('Context')
  const bar = barParts(v.usage?.context.percent ?? null, Math.min(BAR_CELLS, w - 4))
  out.push({ text: `  ${bar.filled}`, style: 'bar', track: bar.track })
  pair('Window', contextLine(v.usage))
  const left = untilCompaction(v.breakdown)
  if (left !== null) pair('Until compaction', formatTokens(left))
  for (const c of categoryRows(v.breakdown)) pair(c.name, `${formatTokens(c.tokens)} · ${formatPercent(c.percent)}`, c.isDim)

  blank()
  title('Rate limits')
  const limits = v.usage?.rateLimits ?? []
  if (limits.length === 0) dim('  none reported')
  for (const r of limits) {
    const line = rateLine(r, now)
    pair(line.label, line.value)
  }

  blank()
  title('Models')
  const { rows, total } = modelLines(v.models)
  if (rows.length === 0) dim('  No requests counted yet.')
  else {
    const cols = MODEL_COLS.filter(c => c.tiers.includes(tier))
    const cells = (l: ModelLine) => [l.name, ...cols.map(c => c.value(l))]
    // Past the tier's columns, a narrow pane drops figures in MODEL_COLS's drop order; the estimate is never dropped or cut.
    const table = fitTable([{ head: 'Model', align: 'l', min: 8 }, ...cols.map(c => c.col)], [...rows.map(cells), ...(rows.length > 1 ? [cells(total)] : [])], w)
    table.forEach((line, i) => out.push({ text: line, style: i === 0 ? 'dim' : 'body' }))
    for (const line of wrapText(priceNote(defaultTtl), w, 2)) dim(line)
  }

  blank()
  title("What's contributing")
  const contributing = contributionLines(v.loops)
  if (contributing.length === 0) dim('  Nothing counted yet.')
  for (const line of contributing) wrapText(line, w, 2).forEach(body)

  blank()
  title('Code changes')
  wrapText(changesLine(t), w, 2).forEach(body)

  blank()
  for (const line of wrapText("Per-model, per-agent and code figures count from when rd-ledger loaded in this session; the cost is the engine's own, from the session's start.", w, 0)) dim(line)
  return out
}
