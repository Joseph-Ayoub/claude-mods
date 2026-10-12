// usage-gauge: pure helpers, everything the chip, the pane and /spend draw
// from $.state. Nothing here touches `$` (the engine's rule keeps every
// function that does at the top of register.tsx), so all of it is unit-tested
// in format.test.ts.

import type { Breakdown, CategoryRow, Counts, RateLimitRow, Totals, Usage } from '../types'
import { CACHE_WRITE_MULTIPLIER, PRICES_AS_OF } from './prices'

/** Caps on drawn text, so nothing an id or a name holds can widen a row past these. */
export const CAP = { model: 32, agentType: 24, category: 40, rateKind: 24 } as const

/**
 * Text that may hold anything (a model id, an agent type, a category name)
 * made safe to draw as one line: control characters, escape codes and line
 * breaks become spaces; format characters (bidi overrides, zero-width,
 * Unicode tags) are dropped; runs of whitespace collapse; the result is cut
 * to `max` code points. Without this a crafted name could forge extra lines
 * in the /spend table the model reads. Copied from mem-gauge's parse.ts.
 */
export const oneLine = (text: string, max: number): string =>
  [
    ...text
      .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/[\p{Cf}\p{Cs}\p{Co}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, max)
    .join('')
    .trim()

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

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
 * (`$12.34`), whole dollars from there (`$123`, `$1,234`); `$ --` unknown.
 */
export function formatUsdChip(usd: number | null): string {
  if (usd === null || !isNum(usd)) return '$ --'
  if (Math.abs(usd) < 100) return formatUsd(usd)
  return `${usd < 0 ? '-' : ''}$${group(String(Math.round(Math.abs(usd))))}`
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
export const formatPercent = (p: number | null): string =>
  p === null || !isNum(p) ? '--' : p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`

/** Pads or cuts `text` to exactly `width` columns (with an ellipsis when cut). */
export function fit(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (width <= 0) return ''
  const chars = [...text]
  if (chars.length > width) return width === 1 ? '…' : `${chars.slice(0, width - 1).join('')}…`
  const pad = ' '.repeat(width - chars.length)
  return align === 'left' ? text + pad : pad + text
}

/** A text gauge for surfaces with no Svg: "███████░░░░░ 62%". */
/**
 * The terminal's context bar: a run of filled cells and a run of track cells,
 * drawn as two spans (the track dim, so it reads as a plain gray; no hatching).
 */
export function barParts(percent: number | null, width: number): { filled: string; track: string; label: string } {
  const cells = Math.max(4, Math.floor(width))
  if (percent === null || !isNum(percent)) return { filled: '', track: '█'.repeat(cells), label: '--' }
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * cells)
  return { filled: '█'.repeat(filled), track: '█'.repeat(cells - filled), label: `${Math.round(percent)}%` }
}

/** Apple system gray: the pill's ink where a surface hands the SVG no theme colour. */
const FALLBACK_INK = '#8E8E93'

const xmlText = (text: string): string => text.replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`)

/** The context bar on the desktop: a 2 px pill about as wide as the Window figure under it, at the right of the Context title. */
export const BAR_WIDTH_PX = 120
export const BAR_HEIGHT_PX = 2
/** The same bar on the terminal, in cells. */
export const BAR_CELLS = 16

const clampPct = (p: number | null): number => (p === null || !isNum(p) ? 0 : Math.min(100, Math.max(0, p)))

/**
 * The context bar: a small thin pill (`width` x `height` px, drawn 1:1), a
 * muted track and a fill in the surface's own ink, that grows from the last
 * drawn percent to this one. The desktop draws a plugin SVG as an image and
 * stamps the theme's text colour on its root, so `currentColor` is white on a
 * dark theme and near-black on a light one; a surface that stamps none gets
 * the system gray. The growth is a CSS animation on the fill's width (off
 * under reduced motion; a renderer that cannot animate it still draws the
 * final width). No script, no external refs.
 */
export function pillSvg(percent: number | null, from: number | null, width = BAR_WIDTH_PX, height = BAR_HEIGHT_PX, title?: string): string {
  const to = clampPct(percent)
  const start = clampPct(from)
  const label = percent === null || !isNum(percent) ? '--' : `${Math.round(percent)}%`
  const aria = xmlText(title ?? `Context ${label} used`)
  const r = height / 2
  const toW = ((to / 100) * width).toFixed(1)
  const fromW = ((start / 100) * width).toFixed(1)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${aria}">` +
    `<style>svg:not([color]){color:${FALLBACK_INK}}` +
    `.fill{animation:grow 480ms cubic-bezier(0.2,0,0,1) both}` +
    `@keyframes grow{from{width:${fromW}px}to{width:${toW}px}}` +
    `@media (prefers-reduced-motion: reduce){.fill{animation:none}}</style>` +
    `<rect x="0" y="0" width="${width}" height="${height}" rx="${r}" fill="currentColor" fill-opacity="0.22"/>` +
    `<rect class="fill" x="0" y="0" width="${toW}" height="${height}" rx="${r}" fill="currentColor"/>` +
    '</svg>'
  )
}

const capital = (word: string): string => (word ? word[0]?.toUpperCase() + word.slice(1) : word)

/**
 * A model id as people say it: `claude-opus-5-5` -> `Opus 5.5`,
 * `claude-fable-5-1[1m]` -> `Fable 5.1`, `claude-3-5-sonnet-20241022` ->
 * `Sonnet 3.5`, `claude-opus-4-20250514` -> `Opus 4`. Anything else is the
 * id without `claude-`, as one capped line.
 */
export function shortModel(model: string): string {
  const id = oneLine(model, 120).toLowerCase()
  const named = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/.exec(id)
  if (named?.[1] && named[2]) return oneLine(`${capital(named[1])} ${named[2]}${named[3] ? `.${named[3]}` : ''}`, CAP.model)
  const legacy = /^claude-(\d{1,2})(?:-(\d{1,2}))?-([a-z]+)/.exec(id)
  if (legacy?.[1] && legacy[3]) return oneLine(`${capital(legacy[3])} ${legacy[1]}${legacy[2] ? `.${legacy[2]}` : ''}`, CAP.model)
  return oneLine(model.replace(/^claude-/, ''), CAP.model) || '?'
}

/** Cache read over everything the requests were answered over, as a percent; null with no input at all. */
export function cacheHitPercent(input: number, cacheRead: number, cacheWrite: number): number | null {
  const total = Math.max(0, input) + Math.max(0, cacheRead) + Math.max(0, cacheWrite)
  return total > 0 ? (Math.max(0, cacheRead) / total) * 100 : null
}

const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0))

/**
 * The lines one Edit / Write / NotebookEdit call changed, from its result's
 * `structuredPatch` hunks (`+` lines added, `-` removed); a Write that created
 * a file with no hunks counts its content's lines. Null (count nothing) for a
 * denied call, an error result, or a change held for review (`staged`).
 */
export function countPatch(ran: unknown): { added: number; removed: number } | null {
  if (!ran || typeof ran !== 'object') return null
  const o = ran as Record<string, unknown>
  if (typeof o['deny'] === 'string' || o['isError'] === true) return null
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

export const emptyCounts = (): Counts => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, apiMs: 0, estUsd: 0, unpriced: 0 })

export const emptyTotals = (loadedAt = 0): Totals => ({
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

const tokensOf = (c: Counts): number => c.input + c.output + c.cacheRead + c.cacheWrite

/** One request added to a row: its four counts, its wall time and its estimate (null: unpriced). */
export function addRequest(
  row: Counts | undefined,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null,
  apiMs: number,
  estUsd: number | null,
): Counts {
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
    oneLine(kind, CAP.rateKind)
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

/** One rate-limit row for the pane and /spend: `5-hour` and `23.5%`, `resets 3:40 PM`. */
export function rateLine(r: RateLimitRow, now: number): { label: string; value: string } {
  const reset = resetText(r.resetsAt, now)
  return { label: rateKind(r.kind), value: `${r.percentUsed}%${reset ? ` · resets ${reset}` : ''}` }
}

/** What a usage reading or a measurement holds, as the engine gives it. */
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
    rateLimits.push({ kind: oneLine(row.kind, CAP.rateKind), percentUsed: row.percentUsed, resetsAt })
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
    categories.push({ name: oneLine(row['name'], CAP.category) || '?', kind, tokens: Math.max(0, row['tokens']) })
  }
  return {
    totalTokens: b['totalTokens'],
    rawMaxTokens: b['rawMaxTokens'],
    percentage: isNum(b['percentage']) ? b['percentage'] : 0,
    autoCompactThreshold: numOrNull(b['autoCompactThreshold']),
    isAutoCompactEnabled: b['isAutoCompactEnabled'] === true,
    model: typeof b['model'] === 'string' ? oneLine(b['model'], CAP.model) : '',
    categories,
  }
}

/** The chip's label: `$123.45 · ctx 12%`, `$ -- · ctx 12%`, `ctx 12%`; null with neither figure. */
export function chipLabel(usage: Usage | null, withContext: boolean): string | null {
  if (!usage) return null
  const pct = usage.context.percent
  const ctx = withContext && pct !== null ? `ctx ${Math.round(pct)}%` : null
  // The desktop strip truncates the whole row to `…` once its chips overflow, so the
  // label stays short: whole dollars from $100, and the context only when asked.
  // Drawn once any figure is known: a reading with neither draws nothing.
  const cost = usage.hasCost && (usage.costUsd !== null || pct !== null) ? formatUsdChip(usage.costUsd) : null
  if (cost === null && ctx === null) return null
  return [cost, ctx].filter(Boolean).join(' · ')
}

/** `120k of 1.0M (12%)`. */
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
export function categoryRows(b: Breakdown | null, max = 8): { name: string; tokens: number; percent: number | null; isDim: boolean }[] {
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
export function modelLines(models: Readonly<Record<string, Counts>>): { rows: ModelLine[]; total: ModelLine } {
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

/** Main loop against subagents, and the top subagent types, by est. cost (by tokens when nothing is priced). */
export function contributions(loops: { main: Counts; agents: Readonly<Record<string, Counts>> }): {
  basis: 'cost' | 'tokens'
  main: number
  agents: number
  types: { key: string; percent: number }[]
} | null {
  const agents = Object.entries(loops.agents)
  const isCost = loops.main.estUsd + agents.reduce((s, [, c]) => s + c.estUsd, 0) > 0
  const of = (c: Counts) => (isCost ? c.estUsd : tokensOf(c))
  const all = shares([['main', of(loops.main)], ...agents.map(([type, c]): [string, number] => [`agent:${type}`, of(c)])])
  if (all.length === 0) return null
  const main = all.find(s => s.key === 'main')?.percent ?? 0
  const types = all.filter(s => s.key.startsWith('agent:')).map(s => ({ key: s.key.slice(6), percent: s.percent }))
  return { basis: isCost ? 'cost' : 'tokens', main, agents: 100 - main, types: types.slice(0, 5) }
}

/** `main loop 40% · subagents 60%`, and `builder 35% · verifier 15%`. */
export function contributionLines(loops: { main: Counts; agents: Readonly<Record<string, Counts>> }): string[] {
  const c = contributions(loops)
  if (!c) return []
  const lines = [`main loop ${formatPercent(c.main)} · subagents ${formatPercent(c.agents)}`]
  if (c.types.length > 0) lines.push(c.types.map(t => `${oneLine(t.key, CAP.agentType)} ${formatPercent(t.percent)}`).join(' · '))
  return lines
}

/** `+4,321 −321 lines · 42 edits`. */
export const changesLine = (t: Totals): string =>
  `+${formatCount(t.linesAdded)} −${formatCount(t.linesRemoved)} lines · ${formatCount(t.edits)} edit${t.edits === 1 ? '' : 's'}`

export const PRICE_NOTE = `Estimates at list price (as of ${PRICES_AS_OF}, cache writes at ${CACHE_WRITE_MULTIPLIER}×); the headline cost is the engine's own ledger.`

/** Everything the pane and /spend draw, read from $.state. */
export type View = {
  usage: Usage | null
  breakdown: Breakdown | null
  totals: Totals
  models: Readonly<Record<string, Counts>>
  loops: { main: Counts; agents: Readonly<Record<string, Counts>> }
}

/** The latest moment the state knows of: the pane's "now", so drawing makes no clock call. */
export const viewNow = (v: View): number => Math.max(v.usage?.at ?? 0, v.totals.updatedAt, v.totals.loadedAt)

/** How long the session has run, from the engine's start to the latest reading. */
export const sessionMs = (v: View): number | null => (v.usage?.startedAt == null ? null : Math.max(0, viewNow(v) - v.usage.startedAt))

/** One line for an origin that is not the person: cost, context and requests. */
export function summaryLine(v: View): string {
  const parts = [formatUsd(v.usage?.costUsd ?? null)]
  if (v.usage?.context.percent != null) parts.push(`ctx ${Math.round(v.usage.context.percent)}%`)
  parts.push(`${formatCount(v.totals.requests)} request${v.totals.requests === 1 ? '' : 's'}`)
  return `Usage: ${parts.join(' · ')}`
}

/** The /spend answer where no pane can be placed (`claude -p`): a short plain table. */
export function compactReport(v: View): string {
  const now = viewNow(v)
  const label = (text: string) => fit(text, 13)
  const lines = [
    'Usage (usage-gauge)',
    `${label('Cost')}${formatUsd(v.usage?.costUsd ?? null)}${v.usage && !v.usage.hasCost ? ' (no cost ledger on this host)' : ''}`,
    `${label('Session')}${formatDuration(sessionMs(v))} · active ${formatDuration(v.totals.activeMs)} · API ${formatDuration(v.totals.apiMs)}`,
    `${label('Turns')}${formatCount(v.totals.turns)} · ${formatCount(v.totals.requests)} requests`,
    `${label('Context')}${contextLine(v.usage)}`,
  ]
  const limits = v.usage?.rateLimits ?? []
  lines.push(`${label('Rate limits')}${limits.length === 0 ? 'none reported' : limits.map(r => { const l = rateLine(r, now); return `${l.label} ${l.value}` }).join(' · ')}`)
  const { rows } = modelLines(v.models)
  for (const row of rows) {
    lines.push(
      `${label(row === rows[0] ? 'Models' : '')}${row.name}: ${formatCount(row.requests)} req, out ${formatTokens(row.output)}, ` +
        `cache hit ${formatPercent(row.hit)}, est ${row.estUsd === null ? '--' : formatUsd(row.estUsd)}${row.share === null ? '' : ` (${formatPercent(row.share)})`}`,
    )
  }
  const contributing = contributionLines(v.loops)
  if (contributing.length > 0) lines.push(`${label('Contributing')}${contributing.join(' · ')}`)
  lines.push(`${label('Code changes')}${changesLine(v.totals)}`)
  if (rows.length > 0) lines.push(PRICE_NOTE)
  return lines.join('\n')
}
