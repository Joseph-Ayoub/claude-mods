// rd-ledger: plain-text answers and the monthly log pages (SPEC §6, §6.4).
// Workstream W3. Pure. Text answers carry counts, hours and validated ids
// only, never repo keys or branch names (CYB-13): every id, model, zone and
// week passes a shape check before it is drawn, and anything that fails it is
// drawn as a fixed placeholder, so a hostile name in the store can neither
// reach a headless transcript nor add a line to one.
//
// The calendar helpers below (local clock, ISO weeks, UTC ISO) are this
// module's own because tz.ts was built in parallel; they read the zone through
// Intl and never read the clock: the caller passes every instant.

import type { Allocation, Block, Rollup, SessionRow, SessionSummary, SpendRow } from '../types'
import { PRICES_AS_OF } from './prices'
import { IGNORED, NON_RD, UNMAPPED } from './store'
import { compactInt, hoursText, isDate, isId, isMonth, isWeek, money, oneLine } from './text'

// --- calendar arithmetic (days since 1970-01-01, proleptic Gregorian) ---------------

const DAY_MS = 86_400_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** Year, month and day of a day number (Hinnant's civil_from_days). */
const civil = (days: number): { y: number; m: number; d: number } => {
  const z = days + 719_468
  const era = Math.floor(z / 146_097)
  const doe = z - era * 146_097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d }
}

/** The day number of a `YYYY-MM-DD` date (shape-checked by the caller). */
export const dayNumber = (date: string): number => Math.floor(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS)

/** The `YYYY-MM-DD` of a day number. */
export const dateOfDay = (days: number): string => {
  const c = civil(days)
  return `${pad(c.y, 4)}-${pad(c.m)}-${pad(c.d)}`
}

/** Monday = 0 … Sunday = 6 (1970-01-01 was a Thursday). */
const weekdayIndex = (days: number): number => (((days + 3) % 7) + 7) % 7

/** The ISO week `YYYY-Www` of a calendar date. */
export const isoWeekOfDate = (date: string): string => {
  const days = dayNumber(date)
  const thursday = days - weekdayIndex(days) + 3
  const year = civil(thursday).y
  const week = Math.floor((thursday - dayNumber(`${pad(year, 4)}-01-01`)) / 7) + 1
  return `${pad(year, 4)}-W${pad(week)}`
}

/** The day number of the Monday that starts an ISO week (shape-checked by the caller). */
export const weekMondayDay = (week: string): number => {
  const jan4 = dayNumber(`${week.slice(0, 4)}-01-04`)
  return jan4 - weekdayIndex(jan4) + (Number(week.slice(6, 8)) - 1) * 7
}

/** The seven dates of an ISO week, Monday first. */
export const weekDateList = (week: string): string[] => {
  const monday = weekMondayDay(week)
  return Array.from({ length: 7 }, (_, i) => dateOfDay(monday + i))
}

/** The month before `YYYY-MM`. */
export const monthBefore = (month: string): string => {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return m === 1 ? `${pad(y - 1, 4)}-12` : `${pad(y, 4)}-${pad(m - 1)}`
}

/** `ms` as ISO 8601 in UTC with milliseconds, the shape of toISOString, without constructing a Date. */
export const utcIso = (ms: number): string => {
  const t = Math.floor(Number.isFinite(ms) ? ms : 0)
  const days = Math.floor(t / DAY_MS)
  const rest = t - days * DAY_MS
  const hh = Math.floor(rest / 3_600_000)
  const mi = Math.floor((rest % 3_600_000) / 60_000)
  const ss = Math.floor((rest % 60_000) / 1000)
  return `${dateOfDay(days)}T${pad(hh)}:${pad(mi)}:${pad(ss)}.${pad(rest % 1000, 3)}Z`
}

export type LocalClock = {
  /** `YYYY-MM-DD` of `ts` in the zone */
  date: (ts: number) => string
  /** `HH:MM` of `ts` in the zone */
  hm: (ts: number) => string
  /** ISO 8601 with the zone's offset at that instant, seconds precision, e.g. `2026-10-11T09:00:00-04:00` */
  iso: (ts: number) => string
}

/**
 * One Intl formatter for `zone`, reused for every row of an export (building
 * one per row costs seconds over a year of rows). An unknown zone throws
 * RangeError here, loudly, before any file is built.
 */
export const localClock = (zone: string): LocalClock => {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const parts = (ts: number) => {
    const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 }
    for (const p of fmt.formatToParts(ts)) if (p.type in out) out[p.type as keyof typeof out] = Number(p.value)
    if (out.hour === 24) out.hour = 0
    return out
  }
  const dateOf = (p: ReturnType<typeof parts>) => `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`
  return {
    date: ts => dateOf(parts(ts)),
    hm: ts => {
      const p = parts(ts)
      return `${pad(p.hour)}:${pad(p.minute)}`
    },
    iso: ts => {
      const whole = Math.floor(ts / 1000) * 1000
      const p = parts(whole)
      const offsetMin = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole) / 60_000)
      const sign = offsetMin < 0 ? '-' : '+'
      const abs = Math.abs(offsetMin)
      return `${dateOf(p)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
    },
  }
}

// --- what a text answer may carry (CYB-13) -------------------------------------------

export const BUCKETS: ReadonlySet<string> = new Set([UNMAPPED, IGNORED, NON_RD])
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@[\]-]{0,79}$/
const ZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,3}$/
const METHOD_RE = /^[a-z0-9-]{1,20}\/[0-9a-f]{8}$/
const REASON_RE = /^(?:origin:)?[a-z0-9-]{1,40}$/
const FLAG_KINDS: ReadonlySet<string> = new Set(['day-over-cap', 'block-over-4h', 'automation-heavy', 'rows-dropped'])

/** A component or entity id, or a bucket name; anything else is drawn as a placeholder. */
export const idText = (s: string | null | undefined): string => (typeof s === 'string' && (isId(s) || BUCKETS.has(s)) ? s : '(unrecognized id)')
/** An entity id; empty (a bucket with no entity) reads `-`. */
const entityText = (s: string | null | undefined): string => (s === '' ? '-' : idText(s))
export const modelText = (s: string | null | undefined): string => (typeof s === 'string' && MODEL_RE.test(s) ? s : '(unrecognized model)')
const zoneText = (s: string): string => (typeof s === 'string' && s.length <= 64 && ZONE_RE.test(s) ? s : '(unrecognized zone)')
const methodText = (s: string): string => (typeof s === 'string' && METHOD_RE.test(s) ? s : '(unrecognized method)')
const weekText = (s: string): string => (isWeek(s) ? s : '(unrecognized week)')
const seconds = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)
const count = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** `line` cut to `width` code points, the last one an ellipsis when cut. */
const fit = (line: string, width: number): string => {
  const chars = [...line]
  return chars.length <= width ? line : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`
}

/** Buckets after the components: `__non_rd__`, then `__unmapped__`, then `__ignored__`. */
const bucketRank = (id: string): number => (id === NON_RD ? 1 : id === UNMAPPED ? 2 : id === IGNORED ? 3 : 0)
const byComponent = (a: string, b: string): number => bucketRank(a) - bucketRank(b) || (a < b ? -1 : a > b ? 1 : 0)

const shortDate = (days: number): string => {
  const c = civil(days)
  return `${MONTHS[c.m - 1]} ${c.d}`
}

const ROW_STATUS_TEXT: Record<string, string> = { pretag: 'pretag', confirmed: 'confirmed', changed: 'changed since confirmation' }

const BRIDGE_TEXT: Record<string, string> = {
  off: 'off',
  standalone: 'standalone (rd-tracker not found)',
  unreachable: 'rd-tracker unreachable',
  corroborate: 'corroborate (rd-tracker reachable)',
  'source-of-truth': 'source of truth (rd-tracker reachable)',
}

export const ESTIMATE_LABEL = 'list-price estimate, not an invoice'
export const FORM_6765_NOTE = 'Form 6765 Section G applies to tax years beginning after 2025 unless an exemption applies (R40, R41)'

/** Spend rows summed by one key, largest estimate first, then by key. */
const sumBy = (rows: readonly SpendRow[], key: (r: SpendRow) => string): { key: string; turns: number; in: number; out: number; cr: number; cw: number; usd: number; unpriced: number }[] => {
  const acc = new Map<string, { key: string; turns: number; in: number; out: number; cr: number; cw: number; usd: number; unpriced: number }>()
  for (const r of rows) {
    const k = key(r)
    const a = acc.get(k) ?? { key: k, turns: 0, in: 0, out: 0, cr: 0, cw: 0, usd: 0, unpriced: 0 }
    a.turns += count(r.turns)
    a.in += count(r.in)
    a.out += count(r.out)
    a.cr += count(r.cr)
    a.cw += count(r.cw)
    if (r.priced && r.usd !== null && Number.isFinite(r.usd)) a.usd += r.usd
    else a.unpriced += count(r.turns)
    acc.set(k, a)
  }
  return [...acc.values()].sort((a, b) => b.usd - a.usd || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

const rowsUsd = (rows: readonly SpendRow[]): number => rows.reduce((s, r) => s + (r.priced && r.usd !== null && Number.isFinite(r.usd) ? r.usd : 0), 0)

/** This week's and last week's review statuses, by week string. */
const reviewOf = (rollup: Rollup, week: string) => rollup.reviews.find(r => r.week === week) ?? null
const lastReview = (rollup: Rollup) =>
  rollup.reviews.filter(r => isWeek(r.week) && r.week < rollup.week).sort((a, b) => (a.week < b.week ? 1 : -1))[0] ?? null
const reviewText = (r: { week: string; confirmed: boolean; rev: number; changedRows: number } | null, week: string): string => {
  if (!r) return `${weekText(week)} open`
  const changed = count(r.changedRows) > 0 ? ` (${plural(count(r.changedRows), 'row', 'rows')} changed since confirmation)` : ''
  return `${weekText(r.week)} ${r.confirmed ? `confirmed rev ${count(r.rev)}` : 'open'}${changed}`
}

/** CONTRACT (W3). The Overview as text for a headless session, ≤ `width` columns. */
export const overviewText = (rollup: Rollup, width: number): string => {
  const w = Number.isFinite(width) && width >= 1 ? Math.floor(width) : 80
  const out: string[] = []

  // 1. This week
  const range = isWeek(rollup.week) ? `${shortDate(weekMondayDay(rollup.week))} – ${shortDate(weekMondayDay(rollup.week) + 6)}` : weekText(rollup.week)
  out.push(`This week  ${range} · ${zoneText(rollup.zone)} · ${methodText(rollup.method)}`)
  const comps = new Map<string, { entity: string; seconds: number; statuses: Set<string> }>()
  for (const row of rollup.weekRows) {
    if (row.component === UNMAPPED || row.component === IGNORED) continue
    const c = comps.get(row.component) ?? { entity: row.entity, seconds: 0, statuses: new Set<string>() }
    c.seconds += seconds(row.seconds)
    c.statuses.add(row.status)
    comps.set(row.component, c)
  }
  const ids = [...comps.keys()].sort(byComponent)
  const idWidth = Math.min(24, Math.max(12, ...ids.map(id => idText(id).length)))
  for (const id of ids) {
    const c = comps.get(id) as { entity: string; seconds: number; statuses: Set<string> }
    const status = c.statuses.has('changed') ? 'changed' : c.statuses.size === 1 && c.statuses.has('confirmed') ? 'confirmed' : 'pretag'
    out.push(`  ${idText(id).padEnd(idWidth)}  ${entityText(c.entity).padEnd(12)}  ${hoursText(c.seconds).padStart(9)}  ${ROW_STATUS_TEXT[status]}`)
  }
  out.push(`  ${UNMAPPED.padEnd(idWidth)}  ${''.padEnd(12)}  ${hoursText(seconds(rollup.weekUnmappedS)).padStart(9)}`)
  out.push(`  ${IGNORED.padEnd(idWidth)}  ${''.padEnd(12)}  ${hoursText(seconds(rollup.weekIgnoredS)).padStart(9)}`)
  out.push(`  ${'Total'.padEnd(idWidth)}  ${''.padEnd(12)}  ${hoursText(seconds(rollup.weekTotalS)).padStart(9)}`)
  out.push(`  ${'Today'.padEnd(idWidth)}  ${''.padEnd(12)}  ${hoursText(seconds(rollup.todayS)).padStart(9)}`)
  const flags = rollup.flags.filter(f => FLAG_KINDS.has(f.kind) && isDate(f.date))
  for (const f of flags.slice(0, 5)) out.push(`  Flag: ${f.kind} ${f.date}`)
  if (flags.length > 5) out.push(`  and ${flags.length - 5} more flags`)

  // 2. Queue: the count and the hours only, never a repository name (CYB-13)
  const queueS = rollup.queue.reduce((s, q) => s + seconds(q.seconds), 0)
  out.push('', `Queue  ${plural(rollup.queue.length, 'repository', 'repositories')} unmapped (${(queueS / 3600).toFixed(1)} h) · map them in /rd review`)

  // 3. Review status
  out.push('', `Review  this week ${reviewText(reviewOf(rollup, rollup.week), rollup.week)}`)
  const last = lastReview(rollup)
  if (last) out.push(`        last week ${reviewText(last, last.week)}`)
  out.push(`        bridge ${BRIDGE_TEXT[rollup.health.bridge] ?? '(unrecognized bridge status)'}`)

  // 4. Spend this month
  const monthUsd = rollup.spendMonthUsd ?? (rollup.spendMonth.length > 0 ? rowsUsd(rollup.spendMonth) : null)
  out.push('', `Spend this month  ${money(monthUsd)} · ${ESTIMATE_LABEL}`)
  for (const m of sumBy(rollup.spendMonth, r => r.model).slice(0, 3)) out.push(`  ${modelText(m.key)}  ${money(m.usd)}${m.unpriced > 0 ? ` (${plural(m.unpriced, 'turn', 'turns')} unpriced)` : ''}`)
  if (rollup.engineCost) out.push(`  engine /cost figure ${money(rollup.engineCost.usd)} over ${plural(count(rollup.engineCost.segments), 'segment', 'segments')}`)
  out.push('  details in /rd spend')

  // 5. Deadlines
  out.push('', 'Deadlines (calendar tax year; verify with your CPA)')
  const deadlines = rollup.deadlines.filter(d => isDate(d.date)).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  for (const d of deadlines.slice(0, 8)) out.push(`  ${d.date}  ${oneLine(d.label, 60)}${d.entity === null ? '' : `  ${idText(d.entity)}`}`)
  out.push(`  ${FORM_6765_NOTE}`)

  // 6. Data health
  const h = rollup.health
  out.push('', 'Data health')
  out.push(`  ${plural(count(h.sessionsInScope), 'session', 'sessions')} · ${plural(count(h.segmentsInScope), 'segment', 'segments')} · ${count(h.unreadable)} unreadable`)
  const denied = Object.keys(h.deniedByReason).sort().map(r => `${REASON_RE.test(r) ? r : '(unrecognized reason)'} ${count(h.deniedByReason[r] as number)}`)
  out.push(`  denied events: ${denied.length === 0 ? 'none' : denied.join(' · ')}`)
  out.push(`  ${count(h.redactions)} redactions · ${count(h.rowsDropped)} dropped rows`)
  const detected = h.zoneDetectedNow !== null && h.zoneDetectedNow !== h.zone ? ` (this Mac now reads ${zoneText(h.zoneDetectedNow)})` : ''
  out.push(`  zone ${zoneText(h.zone)}${detected}`)
  out.push(`  prices as of ${isDate(h.pricesAsOf) ? h.pricesAsOf : PRICES_AS_OF}`)
  out.push(`  ${h.daysSinceExport === null ? 'never exported' : `last export ${plural(count(h.daysSinceExport), 'day', 'days')} ago`}`)
  if (h.storeIsLink) out.push('  warning: the store is a symbolic link')
  if (h.lockStaleMs !== null) out.push(`  warning: a store lock from a crashed session is ${Math.round(h.lockStaleMs / 60_000)} min old; saves and hand-offs wait until it is cleared in the pane`)
  if (h.readOnly) out.push('  read-only: a newer build wrote this store')
  out.push(`  bridge ${BRIDGE_TEXT[h.bridge] ?? '(unrecognized bridge status)'}`)

  out.push('', 'Commands  /rd review · /rd spend · /rd export')
  return out.map(line => fit(line, w)).join('\n')
}

/** CONTRACT (W3). One line: hours this week, today, queue size, review status. */
export const summaryLine = (rollup: Rollup): string => {
  const review = reviewOf(rollup, rollup.week)
  const state = review && review.confirmed ? `confirmed rev ${count(review.rev)}` : 'open'
  return `R&D: ${hoursText(seconds(rollup.weekTotalS))} this week · ${hoursText(seconds(rollup.todayS))} today · ${rollup.queue.length} unmapped · week ${weekText(rollup.week)} ${state}`
}

const tokens = (n: number): string => String(count(n))

const spendMonthLines = (title: string, month: string, rows: readonly SpendRow[], engine: Rollup['engineCost'] | null): string[] => {
  const out = [`${title} ${isMonth(month) ? month : '(unrecognized month)'}: ${money(rowsUsd(rows))} estimated`]
  if (rows.length === 0) return [...out, '  no turns recorded']
  out.push('  By model')
  for (const m of sumBy(rows, r => r.model)) {
    const unpriced = m.unpriced > 0 ? ` (${plural(m.unpriced, 'turn', 'turns')} unpriced)` : ''
    out.push(`    ${modelText(m.key)}  ${plural(m.turns, 'turn', 'turns')}  in ${tokens(m.in)}  out ${tokens(m.out)}  cache read ${tokens(m.cr)}  cache write ${tokens(m.cw)}  ${money(m.usd)}${unpriced}`)
  }
  out.push('  By component')
  const comps = sumBy(rows, r => `${r.component}|${r.entity}`).sort((a, b) => byComponent(a.key.split('|')[0] as string, b.key.split('|')[0] as string) || b.usd - a.usd)
  for (const c of comps) {
    const [component, entity] = c.key.split('|') as [string, string]
    out.push(`    ${idText(component)}  ${entityText(entity)}  ${plural(c.turns, 'turn', 'turns')}  ${money(c.usd)}`)
  }
  if (engine) out.push(`  engine /cost figure ${money(engine.usd)} over ${plural(count(engine.segments), 'segment', 'segments')}`)
  return out
}

/** CONTRACT (W3). The Spend view as text. */
export const spendText = (rollup: Rollup): string => {
  const thisMonth = isDate(rollup.today) ? rollup.today.slice(0, 7) : (rollup.spendMonth[0]?.month ?? '')
  const lastMonth = isMonth(thisMonth) ? monthBefore(thisMonth) : (rollup.spendLastMonth[0]?.month ?? '')
  const out = [`Spend · ${ESTIMATE_LABEL} · prices as of ${isDate(rollup.health.pricesAsOf) ? rollup.health.pricesAsOf : PRICES_AS_OF}`, '']
  out.push(...spendMonthLines('This month', thisMonth, rollup.spendMonth, rollup.engineCost), '')
  out.push(...spendMonthLines('Last month', lastMonth, rollup.spendLastMonth, null), '')
  out.push('Cache writes are priced at the cache TTL in force for each turn (the cacheTtl option where the session recorded none): x1.25 input for 5m, x2.0 for 1h.')
  out.push("The estimate excludes the engine's side calls (compaction, titles); the engine /cost figure is the engine's own number.")
  return out.join('\n')
}

// --- the monthly log -------------------------------------------------------------------

/** Lines per printed page of the monthly log (US Letter at 6 lpi). */
export const LOG_PAGE_LINES = 66

/** CONTRACT (W3). The monthly log: per day, blocks and hours by component; 66-line pages with a header and `Page n of m`. */
export const monthlyLogPages = (month: string, blocks: readonly Block[], allocations: readonly import('../types').Allocation[], zone: string, method: string): string => {
  const valid = isMonth(month)
  const label = valid ? month : '(unrecognized month)'
  const inMonth = (date: string): boolean => valid && isDate(date) && date.startsWith(`${month}-`)
  const clock = localClock(zone)

  const days = new Map<string, { blocks: Block[]; comps: Map<string, { entity: string; seconds: number }> }>()
  const dayOf = (date: string) => {
    const d = days.get(date) ?? { blocks: [], comps: new Map<string, { entity: string; seconds: number }>() }
    days.set(date, d)
    return d
  }
  for (const b of blocks) if (inMonth(b.date)) dayOf(b.date).blocks.push(b)
  for (const a of allocations as readonly Allocation[]) {
    if (!inMonth(a.date)) continue
    const comps = dayOf(a.date).comps
    const key = `${a.component}|${a.entity}`
    const c = comps.get(key) ?? { entity: a.entity, seconds: 0 }
    c.seconds += seconds(a.seconds)
    comps.set(key, c)
  }

  // The body as lines tagged with their day, so a page that opens mid-day can say so.
  const body: { text: string; day: string | null; header: boolean }[] = []
  for (const date of [...days.keys()].sort()) {
    const d = days.get(date) as { blocks: Block[]; comps: Map<string, { entity: string; seconds: number }> }
    body.push({ text: `${date} ${WEEKDAYS[weekdayIndex(dayNumber(date))]}`, day: date, header: true })
    const sorted = d.blocks.slice().sort((a, b) => a.startTs - b.startTs || a.endTs - b.endTs)
    for (const b of sorted) {
      const flag = b.flags.includes('over-4h') ? '  over-4h' : ''
      body.push({ text: `  ${clock.hm(b.startTs)}–${clock.hm(b.endTs)}  ${plural(b.events.length, 'event', 'events')}  ${hoursText(seconds(b.seconds))}${flag}`, day: date, header: false })
    }
    if (d.comps.size > 0) body.push({ text: '  hours by component', day: date, header: false })
    const keys = [...d.comps.keys()].sort((a, b) => byComponent(a.split('|')[0] as string, b.split('|')[0] as string) || (a < b ? -1 : 1))
    for (const key of keys) {
      const c = d.comps.get(key) as { entity: string; seconds: number }
      body.push({ text: `    ${idText(key.split('|')[0])}  ${entityText(c.entity)}  ${hoursText(c.seconds)}`, day: date, header: false })
    }
    body.push({ text: `  day total ${hoursText(sorted.reduce((s, b) => s + seconds(b.seconds), 0))}`, day: date, header: false })
    body.push({ text: '', day: null, header: false })
  }
  if (body.length === 0) body.push({ text: `No engagement recorded in ${label}.`, day: null, header: false })

  // Pages: a header line and a blank line, then the body, padded to exactly LOG_PAGE_LINES.
  const capacity = LOG_PAGE_LINES - 2
  const pages: string[][] = []
  let page: string[] = []
  for (const row of body) {
    if (page.length === capacity) {
      pages.push(page)
      page = []
    }
    if (page.length === 0 && !row.header && row.day !== null) page.push(`${row.day} (continued)`)
    if (page.length === 0 && row.text === '') continue
    page.push(row.text)
  }
  if (page.length > 0 || pages.length === 0) pages.push(page)
  const total = pages.length
  const methodLabel = methodText(method)
  return pages
    .map((lines, i) => {
      const head = [`rd-ledger monthly log ${label} · method ${methodLabel} · page ${i + 1} of ${total}`, '']
      const filled = [...head, ...lines]
      while (filled.length < LOG_PAGE_LINES) filled.push('')
      return filled.join('\n')
    })
    .join('\n')
    .concat('\n')
}

// --- the footer, the Session and Sessions views (SPEC §6.1a, §6.1b, §6.5) ------------------

/** U+29D7, a black hourglass: a monochrome mathematical symbol, not an emoji (the emoji hourglass is U+231B). */
export const TIME_MARK = '\u29D7'
/** The footer chip never grows past this many characters, so the strip never clips it (no space after the mark: the strip is shared with other mods' chips). */
export const FOOTER_MAX = 9

/**
 * The footer chip: the hourglass mark and today's recorded R&D hours (the
 * Overview's "today" figure, engaged union seconds) to one decimal, `--`
 * before the rollup exists. A negative or non-finite figure reads 0.0h and
 * a runaway one a floor, so the chip never outgrows the desktop's mode strip.
 * The one label SessionMode and PromptHint share.
 */
export const footerLabel = (todayS: number | null): string => {
  if (todayS === null) return `${TIME_MARK}--`
  const tenths = Number.isFinite(todayS) ? Math.round((Math.max(0, todayS) / 3600) * 10) : 0
  if (tenths >= 100_000) return `${TIME_MARK}9999h+`
  return `${TIME_MARK}${(tenths / 10).toFixed(1)}h`
}

/**
 * Columns padded to their widest cell, two spaces apart, the first line the
 * header; `align` is per column, `r` for figures. The one table formatter the
 * Session and Sessions views share.
 */
export const textTable = (header: readonly string[], rows: readonly (readonly string[])[], align: readonly ('l' | 'r')[]): string[] => {
  const len = (s: string): number => [...s].length
  const widths = header.map((h, i) => Math.max(len(h), ...rows.map(r => len(r[i] ?? ''))))
  const line = (cells: readonly string[]): string =>
    widths
      .map((w, i) => {
        const cell = cells[i] ?? ''
        const padding = ' '.repeat(Math.max(0, w - len(cell)))
        return align[i] === 'r' ? padding + cell : cell + padding
      })
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(line)]
}

const ID8_RE = /^[0-9a-f]{8}$/i
const AGENT_RE = /^[0-9a-f]{8}$/
const ENTRYPOINT_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/
const id8Text = (s: string): string => (ID8_RE.test(s) ? s.toLowerCase() : '(unrecognized id)')
/** `others` is the row folding the subagents past the twelfth (rollup.ts AGENTS_CAP). */
const agentText = (key: string, merged: number): string => (key === '' ? 'main' : key === 'others' ? `${count(merged)} others` : AGENT_RE.test(key) ? key : '(unrecognized agent)')
const percent = (share: number): string => `${Math.round(Math.max(0, Math.min(1, Number.isFinite(share) ? share : 0)) * 100)} %`
const tokenSum = (t: { in: number; out: number; cr: number; cw: number }): number => count(t.in) + count(t.out) + count(t.cr) + count(t.cw)
/** Local `YYYY-MM-DD HH:MM` in the zone; UTC when the zone is unknown to this runtime. */
const openedText = (ts: number, zone: string): string => {
  try {
    const c = localClock(zone)
    return `${c.date(ts)} ${c.hm(ts)}`
  } catch {
    return `${utcIso(ts).slice(0, 16).replace('T', ' ')} UTC`
  }
}
/** The engine figure when the session recorded one, else the estimate marked `~`. */
const sessionCost = (s: { engineUsd: number | null; estUsd: number | null }): string => (s.engineUsd !== null ? money(s.engineUsd) : `~${money(s.estUsd)}`)

export type SessionTextOptions = {
  /** Draw the repository key: the pane does; a text answer never does (CYB-13) */
  showRepo: boolean
}

/**
 * The Session view as lines: the header, engagement, tokens and cache-hit
 * ratio, both cost figures, the by-model and agents tables, then the
 * recommendations or the line saying there are none. Shared by the current
 * session and a selected one.
 */
export const sessionText = (s: SessionSummary, zone: string, opts: SessionTextOptions): string => {
  const head = [`Session ${id8Text(s.id8)}`, `opened ${openedText(s.openedAt, zone)}`]
  if (opts.showRepo) head.push(`repo ${s.repoKey === null ? '-' : oneLine(s.repoKey, 40)}`)
  head.push(s.entrypoint !== null && ENTRYPOINT_RE.test(s.entrypoint) ? s.entrypoint : 'entrypoint unknown')
  head.push(plural(count(s.segments), 'segment', 'segments'))
  const out = [head.join(' · ')]
  out.push(`Engaged ${hoursText(seconds(s.engagedS))} · ${plural(count(s.prompts), 'prompt', 'prompts')} · ${plural(count(s.turnsMain), 'main turn', 'main turns')} · ${plural(count(s.turnsAgent), 'agent turn', 'agent turns')}`)
  const t = s.tokens
  const hitBase = count(t.in) + count(t.cr) + count(t.cw)
  const hit = hitBase > 0 ? `${Math.round((count(t.cr) / hitBase) * 100)} %` : '-'
  out.push(`Tokens  in ${tokens(t.in)} · out ${tokens(t.out)} · cache read ${tokens(t.cr)} · cache write ${tokens(t.cw)} · cache hit ${hit}`)
  out.push(`Cost  engine /cost figure ${money(s.engineUsd)} · est. ${money(s.estUsd)} (${ESTIMATE_LABEL})`)
  if (count(s.unpricedTurns) > 0) out.push(`  ${plural(count(s.unpricedTurns), 'turn', 'turns')} unpriced (no price row for the model)`)

  out.push('', 'By model')
  if (s.models.length === 0) out.push('  no turns recorded')
  else out.push(...textTable(['Model', 'Turns', 'Est.'], s.models.map(m => [m.model === 'others' && count(m.merged) > 0 ? `${count(m.merged)} other models` : modelText(m.model), String(count(m.turns)), money(m.estUsd)]), ['l', 'r', 'r']).map(l => `  ${l}`))

  out.push('', 'Agents')
  if (s.agents.length === 0) out.push('  no turns recorded')
  else
    out.push(
      ...textTable(
        ['Agent', 'Turns', 'Model', 'Tokens', 'Est.', 'Share'],
        s.agents.map(a => [agentText(a.agentKey, a.merged), String(count(a.turns)), a.model === null ? '-' : modelText(a.model), compactInt(tokenSum(a.tokens)), money(a.estUsd), percent(a.share)]),
        ['l', 'r', 'l', 'r', 'r', 'r'],
      ).map(l => `  ${l}`),
    )

  out.push('')
  if (s.recommendations.length === 0) out.push('No recommendations for this session')
  else out.push('Recommendations', ...s.recommendations.map(r => `  - ${oneLine(r.text, 400)}`))
  return out.join('\n')
}

/** Rows the Sessions view lists at first, and adds per press of More. */
export const SESSIONS_SHOWN = 40
/** The most rows the Sessions view lists: every row the rollup keeps. */
export const SESSIONS_SHOWN_MAX = 300

/** `shown` as a row count the view can use: SESSIONS_SHOWN when it is not a number, clamped to 1..SESSIONS_SHOWN_MAX. */
export const shownRows = (shown: unknown): number => (typeof shown === 'number' && Number.isFinite(shown) ? Math.max(1, Math.min(SESSIONS_SHOWN_MAX, Math.floor(shown))) : SESSIONS_SHOWN)

export type SessionsTextOptions = SessionTextOptions & {
  /** How many rows to list (the persisted sessionsShown) */
  shown: number
  /** The pane has a More button; a text answer does not, so it names only the command */
  hasMore: boolean
}

/**
 * The Sessions view (the global ledger) as lines: one row per session in
 * scope, newest first, `shown` of them, then how many more and how to reach
 * them.
 */
export const sessionsText = (rollup: Rollup, opts: SessionsTextOptions): string => {
  const all: readonly SessionRow[] = rollup.sessions
  const out = [`Sessions this and last month · ${plural(all.length, 'session', 'sessions')}${all.length >= SESSIONS_SHOWN_MAX ? ' (the newest 300)' : ''} · cost is the engine /cost figure, ~ marks a ${ESTIMATE_LABEL}`]
  out.push(`Median est. per engaged hour ${money(rollup.medianUsdPerHour)} (sessions with at least 0.25 h engaged)`)
  if (all.length === 0) return [...out, '', '  no sessions recorded yet'].join('\n')
  const listed = all.slice(0, shownRows(opts.shown))
  const header = ['Date', 'Session', ...(opts.showRepo ? ['Repo'] : []), 'Engaged', 'Turns', 'Agents', 'Cost', 'Recs']
  const align: ('l' | 'r')[] = ['l', 'l', ...(opts.showRepo ? ['l' as const] : []), 'r', 'r', 'r', 'r', 'r']
  const rows = listed.map(s => [
    openedText(s.openedAt, rollup.zone).slice(0, 10),
    id8Text(s.id8),
    ...(opts.showRepo ? [s.repoKey === null ? '-' : oneLine(s.repoKey, 18)] : []),
    hoursText(seconds(s.engagedS)),
    String(count(s.turns)),
    String(count(s.agentCount)),
    sessionCost(s),
    String(count(s.recCount)),
  ])
  out.push('', ...textTable(header, rows, align).map(l => `  ${l}`))
  const more = all.length - listed.length
  if (more > 0) out.push(`  ${more} more — ${opts.hasMore ? 'press More or ' : ''}/rd session <id8>`)
  else out.push('  open one with /rd session <id8>')
  return out.join('\n')
}

/** One option per listed session for the Sessions view's picker: the full id as the value. */
export const sessionOptions = (rollup: Rollup, shown: number): { value: string; label: string }[] =>
  rollup.sessions.slice(0, shownRows(shown)).map(s => ({ value: s.sessionId, label: oneLine(`${openedText(s.openedAt, rollup.zone).slice(0, 10)} ${id8Text(s.id8)} ${s.repoKey === null ? '' : oneLine(s.repoKey, 18)} ${sessionCost(s)}`, 60) }))
