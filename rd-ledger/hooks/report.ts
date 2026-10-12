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
export const fit = (line: string, width: number): string => {
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

const BRIDGE_TEXT: Record<string, string> = {
  off: 'off',
  standalone: 'standalone (rd-tracker not found)',
  unreachable: 'rd-tracker unreachable',
  corroborate: 'corroborate (rd-tracker reachable)',
  'source-of-truth': 'source of truth (rd-tracker reachable)',
}

export const ESTIMATE_LABEL = 'list-price estimate, not an invoice'

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
// --- width: tiers, wrapping and tables (SPEC §6) ----------------------------------------

/** The pane's three widths: wide ≥ 84 columns, medium 60–83, narrow below 60. */
export type Tier = 'wide' | 'medium' | 'narrow'
export const tierOf = (cols: number): Tier => (cols >= 84 ? 'wide' : cols >= 60 ? 'medium' : 'narrow')
/** A renderer's width: a finite width of at least 1, else 80 (a text answer with no known width). */
const widthOf = (width: number): number => (Number.isFinite(width) && width >= 1 ? Math.floor(width) : 80)
const len = (s: string): number => [...s].length

/**
 * `text` wrapped to `width` code points: the first line indented by `indent`
 * spaces, the rest by `indent + 2` so a wrapped item reads as one. Breaks at
 * whitespace (the run of spaces at a break is dropped, runs inside a line are
 * kept); a word longer than a line is cut across lines rather than lost. Free
 * text in the views (notes, recommendations, captions, warnings) goes through
 * this instead of being cut with an ellipsis, so nothing is silently hidden.
 */
export const wrapText = (text: string, width: number, indent = 0): string[] => {
  const w = Math.max(1, widthOf(width))
  const first = ' '.repeat(Math.max(0, Math.min(indent, w - 1)))
  const rest = ' '.repeat(Math.max(0, Math.min(indent + 2, w - 1)))
  const out: string[] = []
  let line = first
  let has = false
  const tokens = [...String(text).matchAll(/(\s*)(\S+)/g)].map(m => ({ sep: m[1] ?? '', word: m[2] ?? '' }))
  for (const t of tokens) {
    let chars = [...t.word]
    let sep = t.sep === '' ? '' : t.sep
    while (chars.length > 0) {
      const gap = has ? len(sep) : 0
      if (len(line) + gap + chars.length <= w) {
        line += (has ? sep : '') + chars.join('')
        has = true
        chars = []
      } else if (has) {
        out.push(line)
        line = rest
        has = false
        sep = ''
      } else {
        const take = Math.max(1, w - len(line))
        line += chars.slice(0, take).join('')
        chars = chars.slice(take)
        out.push(line)
        line = rest
      }
    }
  }
  if (has) out.push(line)
  return out.length > 0 ? out : ['']
}

/**
 * A table column. `align: 'r'` marks a figure: its cells are never cut.
 * `drop` is the column's place in the drop order (1 goes first); a column
 * without one is never dropped. `min` is the narrowest a text column may be
 * cut to (default 6); an id column sets its own width so it is never cut.
 */
export type Col = { head: string; align: 'l' | 'r'; drop?: number; min?: number }

/**
 * A table fitted to `width`: columns padded to their widest cell and two
 * spaces apart, figures right-aligned, the header first. While it is too wide
 * the widest text column above its `min` gives up a character (its cells cut
 * with an ellipsis); when none can, the next column in the drop order goes.
 * A figure is never cut: a figure column is either drawn whole or dropped.
 * Only when nothing is left to shrink or drop is a line cut to `width`, so
 * the invariant (no line past the pane) still holds.
 */
export const fitTable = (cols: readonly Col[], rows: readonly (readonly string[])[], width: number, indent = 2): string[] => {
  const w = widthOf(width)
  const natural = cols.map((c, i) => Math.max(len(c.head), ...rows.map(r => len(r[i] ?? ''))))
  const widths = natural.slice()
  const shown = cols.map(() => true)
  const total = (): number => {
    const live = widths.filter((_, i) => shown[i])
    return indent + live.reduce((a, b) => a + b, 0) + 2 * Math.max(0, live.length - 1)
  }
  while (total() > w) {
    let best = -1
    cols.forEach((c, i) => {
      if (!shown[i] || c.align !== 'l' || (widths[i] as number) <= Math.min(natural[i] as number, c.min ?? 6)) return
      if (best < 0 || (widths[i] as number) > (widths[best] as number)) best = i
    })
    if (best >= 0) {
      widths[best] = (widths[best] as number) - 1
      continue
    }
    let drop = -1
    cols.forEach((c, i) => {
      if (shown[i] && c.drop !== undefined && (drop < 0 || c.drop < (cols[drop]?.drop as number))) drop = i
    })
    if (drop < 0) break
    shown[drop] = false
    // A dropped column gives its room back: the text columns may grow again.
    cols.forEach((c, i) => {
      if (c.align === 'l') widths[i] = natural[i] as number
    })
  }
  const pad = ' '.repeat(indent)
  const line = (cells: readonly string[]): string =>
    fit(
      pad +
        widths
          .map((cw, i) => {
            if (!shown[i]) return null
            const raw = cells[i] ?? ''
            const cell = cols[i]?.align === 'r' ? raw : fit(raw, cw)
            const fill = ' '.repeat(Math.max(0, cw - len(cell)))
            return cols[i]?.align === 'r' ? fill + cell : cell + fill
          })
          .filter((c): c is string => c !== null)
          .join('  ')
          .trimEnd(),
      w,
    )
  return [line(cols.map(c => c.head)), ...rows.map(line)]
}

/**
 * A label/value pair (a headline figure): the label in a column of
 * `labelWidth`, the value right-aligned in at least 12, when both fit the
 * width; otherwise the label on its own line(s) and the value under it,
 * indented by two more. Neither is ever cut, so a narrow pane still reads
 * every figure. The one pair helper the Session view and the Usage pane share.
 */
export const pairLines = (label: string, value: string, width: number, labelWidth: number, indent = 2): string[] => {
  const w = widthOf(width)
  const lead = ' '.repeat(indent)
  const room = w - indent - labelWidth
  if (len(label) < labelWidth && len(value) <= room) return [`${lead}${label.padEnd(labelWidth)}${' '.repeat(Math.max(0, Math.min(room, Math.max(12, len(value))) - len(value)))}${value}`]
  return [...wrapText(label, w, indent), ...wrapText(value, w, indent + 2)]
}

/** rd-tracker's `hours()`: seconds as hours with two decimals, no unit. */
export const hours = (s: number): string => (seconds(s) / 3600).toFixed(2)

/** One drawn line of a view: section titles bold, captions dim. */
export type ViewLine = { text: string; style: 'title' | 'body' | 'dim' }

const BUCKET_NAME: Record<string, string> = { [NON_RD]: 'non-R&D', [UNMAPPED]: 'unmapped', [IGNORED]: 'ignored' }
const BUCKET_ORDER = [NON_RD, UNMAPPED, IGNORED] as const
const ACTIVITY_NAME: Record<string, string> = { direct_research: 'direct_research', direct_support: 'direct_support', non_qualified: 'non_qualified', unclassified: 'unclassified', mixed: 'mixed' }
const FLAG_REASON: Record<string, string> = {
  'block-over-4h': 'block over the 4 h cap',
  'day-over-cap': 'over the daily flag',
  'automation-heavy': 'automation swamped human turns',
  'rows-dropped': 'rows dropped',
}
const days = (n: number): string => `${n} day(s)`

/**
 * rd-tracker's R41 calendar (rdt/reports/dashboard.py `DEADLINES`), the six
 * obligations its dashboard lists, copied as data so the R&D view reads the
 * same. A row with no calendar date says what it is tied to instead.
 */
export const RDT_DEADLINES: readonly { title: string; due: string | null; when: string }[] = [
  { title: 'Form 6765 Section G becomes mandatory', due: null, when: 'first mandatory tax year: TY2026' },
  { title: '§70302(f)(1) retroactive §174A election window closes', due: '2026-07-06', when: 'fixed statutory date' },
  { title: '§280C(c)(2) late election / revocation window closes', due: '2026-07-06', when: 'fixed date, or the §6511 period if earlier' },
  { title: '§280C reduced-credit election (Form 6765 Item A)', due: null, when: 'original timely filed return, including extensions' },
  { title: '§41(h) qualified small business payroll-tax election (Section D)', due: null, when: 'original timely filed return, including extensions' },
  { title: 'Section G small-filer exemption is lost on an amended return', due: null, when: 'whenever an amended return is filed' },
]
const CPA_CAVEAT = 'Calendar tax year; dates are not moved for weekends or holidays; verify with your CPA.'
const LABEL_CAVEAT = ' (calendar tax year; verify with your CPA)'

/** A deadline's status against today, rd-tracker's wording. */
const deadlineStatus = (due: string | null, today: string): string => {
  if (due === null || !isDate(due) || !isDate(today)) return 'no calendar date — see due'
  const n = dayNumber(due) - dayNumber(today)
  return n < 0 ? `CLOSED ${days(-n)} ago` : `${days(n)} remaining`
}

/** The week-over-week change in words. */
const deltaText = (now: number, before: number): string => {
  if (!(before > 0)) return 'no prior period'
  const pct = ((now - before) / before) * 100
  if (Math.abs(pct) > 999) return `${pct > 0 ? 'up' : 'down'} over 999% vs last week`
  const shown = Math.abs(pct).toFixed(1)
  if (shown === '0.0') return 'no change vs last week'
  return `${pct > 0 ? 'up' : 'down'} ${shown}% vs last week`
}

/** Local `HH:MM` and date of `ts`, UTC when the zone is unknown here. */
const atText = (ts: number, zone: string): string => {
  try {
    const c = localClock(zone)
    return `${c.hm(ts)} on ${c.date(ts)}`
  } catch {
    return `${utcIso(ts).slice(11, 16)} UTC on ${utcIso(ts).slice(0, 10)}`
  }
}

/**
 * CONTRACT (W3). The R&D view as drawn lines, ≤ `width` columns each (SPEC
 * §6.1): the header, Hours in range, Weekly trend, Hours by entity, Hours by
 * component, Activity mix, Review status, Spend this month, Pipeline and
 * Deadlines, rd-tracker's dashboard in text. Tables drop columns by tier and
 * free text wraps. Ids, zones and reasons pass the same shape checks as every
 * text answer (CYB-13): no repository key or branch is ever drawn here.
 */
export const rdLines = (rollup: Rollup, width: number): ViewLine[] => {
  const w = widthOf(width)
  const tier = tierOf(w)
  const out: ViewLine[] = []
  const title = (t: string) => out.push(...wrapText(t, w, 0).map((text, i) => ({ text, style: i === 0 ? ('title' as const) : ('body' as const) })))
  const body = (t: string, indent = 2) => out.push(...wrapText(t, w, indent).map(text => ({ text, style: 'body' as const })))
  const dim = (t: string, indent = 4) => out.push(...wrapText(t, w, indent).map(text => ({ text, style: 'dim' as const })))
  const table = (cols: readonly Col[], rows: readonly (readonly string[])[]) => out.push(...fitTable(cols, rows, w).map(text => ({ text, style: 'body' as const })))
  const gap = () => out.push({ text: '', style: 'body' })
  const kv = (label: string, value: string) => out.push({ text: fit(`  ${label.padEnd(12)}${value.padStart(8)}`, w), style: 'body' })

  const monday = isWeek(rollup.week) ? weekMondayDay(rollup.week) : null
  const range = monday === null ? weekText(rollup.week) : `${shortDate(monday)} – ${shortDate(monday + 6)}`
  out.push(...wrapText(`R&D ledger · week of ${range} · ${zoneText(rollup.zone)} · ${methodText(rollup.method)}`, w, 0).map(text => ({ text, style: 'title' as const })))

  // Hours in range
  gap()
  title('Hours in range')
  kv('Net hours', hours(rollup.weekTotalS))
  dim('engaged time, gaps removed; the figure a claim is built from')
  kv('Gross span', hours(rollup.weekGrossS))
  dim('first to last prompt each day, gaps included (context, not a claim basis)')
  kv('Today', hours(rollup.todayS))
  body(deltaText(seconds(rollup.weekTotalS), seconds(rollup.lastWeekTotalS)))

  // Weekly trend
  gap()
  title('Weekly trend')
  // Every week in scope (at most ten); the Total foots exactly the rows shown.
  const trend = rollup.weekTrend
  const narrow = tier === 'narrow'
  const trendCols: Col[] = [{ head: 'ISO week', align: 'l', min: 18 }, { head: 'Net hours', align: 'r' }, ...(narrow ? [] : [{ head: 'Gross span', align: 'r' as const, drop: 1 }])]
  const trendRow = (week: string, n: number, g: number) => [week, hours(n), ...(narrow ? [] : [hours(g)])]
  // The oldest week can start before the first of last month: only its in-scope days are counted, so it says so.
  const scopeStart = isDate(rollup.today) ? dayNumber(`${monthBefore(rollup.today.slice(0, 7))}-01`) : null
  const isPartial = (week: string) => isWeek(week) && scopeStart !== null && weekMondayDay(week) < scopeStart
  // The tag is never cut: wide and medium carry it in the cell, narrow prints the week alone and says so under the table.
  const weekLabel = (week: string) => (isPartial(week) && !narrow ? `${week} (partial)` : weekText(week))
  table(trendCols, [...trend.map(t => trendRow(weekLabel(t.week), t.netS, t.grossS)), trendRow('Total', trend.reduce((s, t) => s + seconds(t.netS), 0), trend.reduce((s, t) => s + seconds(t.grossS), 0))])
  for (const t of trend) if (narrow && isPartial(t.week)) dim(`(partial) ${t.week} starts before the first of last month; only its in-scope days count`, 2)

  // Hours by entity: the buckets always print, so the rows add up to the week
  gap()
  title('Hours by entity')
  const entityS = (id: string) => rollup.byEntity.filter(e => e.entity === id).reduce((s, e) => s + seconds(e.seconds), 0)
  const entities = rollup.byEntity.filter(e => !BUCKETS.has(e.entity))
  const entityRows = [...entities.map(e => [entityText(e.entity), hours(e.seconds)]), ...BUCKET_ORDER.map(b => [BUCKET_NAME[b] as string, hours(entityS(b))])]
  const entityTotal = rollup.byEntity.reduce((s, e) => s + seconds(e.seconds), 0)
  table([{ head: 'Entity', align: 'l' }, { head: 'Net hours', align: 'r' }], [...entityRows, ['Total', hours(entityTotal)]])

  // Hours by component
  gap()
  title('Hours by component')
  const showEntity = tier !== 'narrow'
  const showActivity = tier === 'wide'
  const compCols: Col[] = [{ head: 'Component', align: 'l' }, ...(showEntity ? [{ head: 'Entity', align: 'l' as const, drop: 2 }] : []), ...(showActivity ? [{ head: 'Activity', align: 'l' as const, drop: 1 }] : []), { head: 'Net hours', align: 'r' }]
  const compRow = (name: string, entity: string, activity: string, s: number) => [name, ...(showEntity ? [entity] : []), ...(showActivity ? [activity] : []), hours(s)]
  const compS = (id: string) => rollup.byComponent.filter(c => c.component === id).reduce((s, c) => s + seconds(c.seconds), 0)
  const compRows = rollup.byComponent.filter(c => !BUCKETS.has(c.component)).map(c => compRow(idText(c.component), entityText(c.entity), c.activity === null ? '-' : (ACTIVITY_NAME[c.activity] ?? '-'), c.seconds))
  const compTotal = rollup.byComponent.reduce((s, c) => s + seconds(c.seconds), 0)
  table(compCols, [...compRows, ...BUCKET_ORDER.map(b => compRow(BUCKET_NAME[b] as string, '(none)', '-', compS(b))), compRow('Total', '', '', compTotal)])

  // Activity mix
  gap()
  title('Activity mix')
  const mix = rollup.activityMix.filter(a => seconds(a.seconds) > 0)
  table([{ head: 'Activity type', align: 'l' }, { head: 'Net hours', align: 'r' }], [...mix.map(a => [ACTIVITY_NAME[a.activity] ?? '-', hours(a.seconds)]), ['Total', hours(rollup.activityMix.reduce((s, a) => s + seconds(a.seconds), 0))]])
  const qualified = rollup.activityMix.filter(a => a.activity === 'direct_research' || a.activity === 'direct_support')
  const qualS = qualified.reduce((s, a) => s + seconds(a.seconds), 0)
  const poeS = qualified.reduce((s, a) => s + seconds(a.poeS), 0)
  body(`Process-of-experimentation share: ${hours(poeS)} of ${hours(qualS)} qualified-services hours (${qualS > 0 ? `${((poeS / qualS) * 100).toFixed(1)}%` : 'n/a'})`)

  // Review status
  gap()
  title('Review status')
  const queueS = rollup.queue.reduce((s, q) => s + seconds(q.seconds), 0)
  const queueSessions = rollup.queue.reduce((s, q) => s + count(q.sessions), 0)
  body(`${hours(queueS)} hours in the review queue · ${rollup.queue.length} unmapped repo(s), ${queueSessions} session(s)`)
  body('Unconfirmed weeks')
  const open = rollup.weekTrend.filter(t => t.confirmed === false && seconds(t.netS) > 0)
  const changed = rollup.reviews.filter(r => r.confirmed && count(r.changedRows) > 0 && isWeek(r.week))
  for (const t of open) body(`${weekText(t.week)}  unconfirmed  ${hours(t.netS)}`, 4)
  for (const r of changed) body(`${weekText(r.week)}  ${count(r.changedRows)} row(s) changed since confirmation`, 4)
  if (open.length === 0 && changed.length === 0) body('Every week with recorded time is confirmed.', 4)
  const flagged = rollup.flaggedDays.filter(f => isDate(f.date) && FLAG_KINDS.has(f.reason))
  if (flagged.length > 0) {
    body('Days to adjudicate')
    for (const f of flagged.slice(0, 8)) body(`${f.date}  ${FLAG_REASON[f.reason]}  ${hours(f.netS)} net · ${hours(f.grossS)} gross`, 4)
    if (flagged.length > 8) body(`and ${flagged.length - 8} more`, 4)
  } else {
    body('Longest days (no flags)')
    const longest = rollup.longestDays.filter(d => isDate(d.date))
    for (const d of longest) body(`${d.date}  ${hours(d.netS)} net · ${hours(d.grossS)} gross`, 4)
    if (longest.length === 0) body('no time recorded this week', 4)
  }
  body('Confirm weeks in Review (v) — hours are proposals until confirmed.')

  // Spend this month
  gap()
  title('Spend this month')
  const monthUsd = rollup.spendMonthUsd ?? (rollup.spendMonth.length > 0 ? rowsUsd(rollup.spendMonth) : null)
  body(`${monthUsd === null ? 'no priced turns' : `~${money(monthUsd)}`} est. list price · Spend (s)`)

  // Pipeline (the facts the old Data health carried)
  gap()
  title('Pipeline')
  const h = rollup.health
  body(`last refresh at ${atText(rollup.at, rollup.zone)}`)
  body(h.daysSinceExport === null ? 'never exported' : `last export ${days(count(h.daysSinceExport))} ago`)
  body(`bridge ${BRIDGE_TEXT[h.bridge] ?? '(unrecognized bridge status)'}`)
  body(`${plural(count(h.sessionsInScope), 'session', 'sessions')} · ${plural(count(h.segmentsInScope), 'segment', 'segments')} in scope · ${count(h.unreadable)} unreadable`)
  const denied = Object.keys(h.deniedByReason)
    .map(r => ({ r: REASON_RE.test(r) ? r : '(unrecognized reason)', n: count(h.deniedByReason[r] as number) }))
    .sort((a, b) => b.n - a.n || (a.r < b.r ? -1 : a.r > b.r ? 1 : 0))
  body(`denied events: ${denied.length === 0 ? 'none' : denied.slice(0, 5).map(d => `${d.r} ${d.n}`).join(' · ')}${denied.length > 5 ? ` · and ${denied.length - 5} more` : ''}`)
  body(`${count(h.redactions)} redactions · ${count(h.rowsDropped)} dropped rows`)
  body(`prices as of ${isDate(h.pricesAsOf) ? h.pricesAsOf : PRICES_AS_OF}`)
  const detected = h.zoneDetectedNow !== null && h.zoneDetectedNow !== h.zone ? ` (this Mac now reads ${zoneText(h.zoneDetectedNow)})` : ''
  body(`zone ${zoneText(h.zone)}${detected}`)
  if (h.storeIsLink) body('warning: the store is a symbolic link')
  if (typeof h.lockStaleMs === 'number') body(`warning: a store lock from a crashed session is ${Math.round(h.lockStaleMs / 60_000)} min old; saves and hand-offs wait until it is cleared with Clear stale lock (l)`)
  if (h.readOnly) body('read-only: a newer build wrote this store')

  // Deadlines
  gap()
  title('Deadlines')
  for (const d of RDT_DEADLINES) body(`${d.due ?? d.when}  ${d.title} — ${deadlineStatus(d.due, rollup.today)}`)
  const ours = rollup.deadlines.filter(d => isDate(d.date)).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  for (const d of ours.slice(0, 8)) {
    const label = oneLine(d.label.replace(LABEL_CAVEAT, ''), 80)
    body(`${d.date}  ${label}${d.entity === null ? '' : ` · ${idText(d.entity)}`} — ${deadlineStatus(d.date, rollup.today)}`)
  }
  for (const id of rollup.entityIds) body(`Section G exemption · ${idText(id)} — unknown`)
  dim(CPA_CAVEAT, 2)
  return out
}

/** CONTRACT (W3). The R&D view as text (a headless or non-placed answer), ≤ `width` columns. */
export const overviewText = (rollup: Rollup, width: number): string =>
  rdLines(rollup, width)
    .map(l => l.text)
    .join('\n')

/** CONTRACT (W3). One line: hours this week, today, queue size, review status. */
export const summaryLine = (rollup: Rollup): string => {
  const review = reviewOf(rollup, rollup.week)
  const state = review && review.confirmed ? `confirmed rev ${count(review.rev)}` : 'open'
  return `R&D: ${hoursText(seconds(rollup.weekTotalS))} this week · ${hoursText(seconds(rollup.todayS))} today · ${rollup.queue.length} unmapped · week ${weekText(rollup.week)} ${state}`
}

const tokens = (n: number): string => String(count(n))

const spendMonthLines = (title: string, month: string, rows: readonly SpendRow[], engine: Rollup['engineCost'] | null, w: number): string[] => {
  const tier = tierOf(w)
  const out = wrapText(`${title} ${isMonth(month) ? month : '(unrecognized month)'}: ${money(rowsUsd(rows))} estimated`, w, 0)
  if (rows.length === 0) return [...out, '  no turns recorded']
  out.push('  By model')
  // As the pane narrows the table gives up cache write and input (medium), then cache read (narrow).
  const showIn = tier === 'wide'
  const showCw = tier === 'wide'
  const showCr = tier !== 'narrow'
  const cols: Col[] = [
    { head: 'Model', align: 'l' },
    { head: 'Turns', align: 'r', drop: 4 },
    ...(showIn ? [{ head: 'Input', align: 'r' as const, drop: 2 }] : []),
    { head: 'Output', align: 'r', drop: 5 },
    ...(showCr ? [{ head: 'Cache read', align: 'r' as const, drop: 3 }] : []),
    ...(showCw ? [{ head: 'Cache write', align: 'r' as const, drop: 1 }] : []),
    { head: 'Est.', align: 'r' },
  ]
  const models = sumBy(rows, r => r.model)
  out.push(
    ...fitTable(
      cols,
      models.map(m => [modelText(m.key), String(m.turns), ...(showIn ? [compactInt(m.in)] : []), compactInt(m.out), ...(showCr ? [compactInt(m.cr)] : []), ...(showCw ? [compactInt(m.cw)] : []), money(m.usd)]),
      w,
      4,
    ),
  )
  const unpriced = models.filter(m => m.unpriced > 0)
  for (const m of unpriced) out.push(...wrapText(`${modelText(m.key)}: ${plural(m.unpriced, 'turn', 'turns')} unpriced (no price row for the model)`, w, 4))
  out.push('  By component')
  const showEntity = tier !== 'narrow'
  const comps = sumBy(rows, r => `${r.component}|${r.entity}`).sort((a, b) => byComponent(a.key.split('|')[0] as string, b.key.split('|')[0] as string) || b.usd - a.usd)
  out.push(
    ...fitTable(
      [{ head: 'Component', align: 'l' }, ...(showEntity ? [{ head: 'Entity', align: 'l' as const, drop: 1 }] : []), { head: 'Turns', align: 'r', drop: 2 }, { head: 'Est.', align: 'r' }],
      comps.map(c => {
        const [component, entity] = c.key.split('|') as [string, string]
        return [idText(component), ...(showEntity ? [entityText(entity)] : []), String(c.turns), money(c.usd)]
      }),
      w,
      4,
    ),
  )
  if (engine) out.push(...wrapText(`engine /cost figure ${money(engine.usd)} over ${plural(count(engine.segments), 'segment', 'segments')}`, w, 2))
  return out
}

/** CONTRACT (W3). The Spend view as text, ≤ `width` columns. */
export const spendText = (rollup: Rollup, width = 100): string => {
  const w = widthOf(width)
  const thisMonth = isDate(rollup.today) ? rollup.today.slice(0, 7) : (rollup.spendMonth[0]?.month ?? '')
  const lastMonth = isMonth(thisMonth) ? monthBefore(thisMonth) : (rollup.spendLastMonth[0]?.month ?? '')
  const out = [...wrapText(`Spend · ${ESTIMATE_LABEL} · prices as of ${isDate(rollup.health.pricesAsOf) ? rollup.health.pricesAsOf : PRICES_AS_OF}`, w, 0), '']
  out.push(...spendMonthLines('This month', thisMonth, rollup.spendMonth, rollup.engineCost, w), '')
  out.push(...spendMonthLines('Last month', lastMonth, rollup.spendLastMonth, null, w), '')
  out.push(...wrapText('Cache writes are priced at the cache TTL in force for each turn (the cacheTtl option where the session recorded none): x1.25 input for 5m, x2.0 for 1h.', w, 2))
  out.push(...wrapText("The estimate excludes the engine's side calls (compaction, titles); the engine /cost figure is the engine's own number.", w, 2))
  return out.map(l => fit(l, w)).join('\n')
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
 * R&D view's "Today" figure, engaged union seconds) to one decimal, `--`
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
export const sessionText = (s: SessionSummary, zone: string, opts: SessionTextOptions, width = 100): string => {
  const w = widthOf(width)
  const narrow = tierOf(w) === 'narrow'
  const fields = [`opened ${openedText(s.openedAt, zone)}`]
  if (opts.showRepo) fields.push(`repo ${s.repoKey === null ? '-' : oneLine(s.repoKey, 40)}`)
  fields.push(s.entrypoint !== null && ENTRYPOINT_RE.test(s.entrypoint) ? s.entrypoint : 'entrypoint unknown')
  fields.push(plural(count(s.segments), 'segment', 'segments'))
  // The header is one line when it fits, else the id alone and one field per line.
  const joined = `Session ${id8Text(s.id8)} · ${fields.join(' · ')}`
  const out = len(joined) <= w ? [joined] : [...wrapText(`Session ${id8Text(s.id8)}`, w, 0), ...fields.flatMap(f => wrapText(f, w, 2))]

  const labelWidth = narrow ? 14 : 20
  const pair = (label: string, value: string) => out.push(...pairLines(label, value, w, labelWidth))
  const t = s.tokens
  const hitBase = count(t.in) + count(t.cr) + count(t.cw)
  out.push('')
  pair('Engaged hours', hours(s.engagedS))
  pair('Prompts', String(count(s.prompts)))
  pair('Main turns', String(count(s.turnsMain)))
  pair('Agent turns', String(count(s.turnsAgent)))
  pair('Input tokens', tokens(t.in))
  pair('Output tokens', tokens(t.out))
  pair('Cache read', tokens(t.cr))
  pair('Cache write', tokens(t.cw))
  pair('Cache hit', hitBase > 0 ? `${Math.round((count(t.cr) / hitBase) * 100)} %` : '-')
  pair('Engine /cost', money(s.engineUsd))
  pair('Estimate', money(s.estUsd))
  out.push(...wrapText(`the estimate is a ${ESTIMATE_LABEL}`, w, 4))
  if (count(s.unpricedTurns) > 0) out.push(...wrapText(`${plural(count(s.unpricedTurns), 'turn', 'turns')} unpriced (no price row for the model)`, w, 4))

  out.push('', 'By model')
  if (s.models.length === 0) out.push('  no turns recorded')
  else
    out.push(
      ...fitTable(
        [{ head: 'Model', align: 'l' }, { head: 'Turns', align: 'r', drop: 1 }, { head: 'Est.', align: 'r' }],
        s.models.map(m => [m.model === 'others' && count(m.merged) > 0 ? `${count(m.merged)} other models` : modelText(m.model), String(count(m.turns)), money(m.estUsd)]),
        w,
      ),
    )

  out.push('', 'Agents')
  if (s.agents.length === 0) out.push('  no turns recorded')
  else {
    // Narrow drops the model and token columns; the estimate and share stay.
    const cols: Col[] = [{ head: 'Agent', align: 'l', min: 8 }, { head: 'Turns', align: 'r', drop: 3 }, ...(narrow ? [] : [{ head: 'Model', align: 'l' as const, drop: 1 }, { head: 'Tokens', align: 'r' as const, drop: 2 }]), { head: 'Est.', align: 'r' }, { head: 'Share', align: 'r', drop: 4 }]
    out.push(...fitTable(cols, s.agents.map(a => [agentText(a.agentKey, a.merged), String(count(a.turns)), ...(narrow ? [] : [a.model === null ? '-' : modelText(a.model), compactInt(tokenSum(a.tokens))]), money(a.estUsd), percent(a.share)]), w))
  }

  out.push('')
  // Titles wrap like any text: a continuation line is indented, so only the first reads as a title.
  if (s.recommendations.length === 0) out.push(...wrapText('No recommendations for this session', w, 0))
  else {
    out.push('Recommendations')
    for (const r of s.recommendations) out.push(...wrapText(`- ${oneLine(r.text, 400)}`, w, 2))
  }
  return out.map(l => fit(l, w)).join('\n')
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
 * The Sessions view (the global ledger) as lines, ≤ `width` columns: one row
 * per session in scope, newest first, `shown` of them, then how many more and
 * how to reach them. As the pane narrows the table gives up Recs (medium),
 * then Agents and Repo (narrow, where the date drops its year).
 */
export const sessionsText = (rollup: Rollup, opts: SessionsTextOptions, width = 100): string => {
  const w = widthOf(width)
  const tier = tierOf(w)
  const all: readonly SessionRow[] = rollup.sessions
  const out = wrapText(`Sessions this and last month · ${plural(all.length, 'session', 'sessions')}${all.length >= SESSIONS_SHOWN_MAX ? ' (the newest 300)' : ''} · cost is the engine /cost figure, ~ marks a ${ESTIMATE_LABEL}`, w, 0)
  out.push(...wrapText(`Median est. per engaged hour ${money(rollup.medianUsdPerHour)} (sessions with at least 0.25 h engaged)`, w, 2))
  if (all.length === 0) return [...out, '', '  no sessions recorded yet'].map(l => fit(l, w)).join('\n')
  const listed = all.slice(0, shownRows(opts.shown))
  const showRepo = opts.showRepo && tier !== 'narrow'
  const showAgents = tier !== 'narrow'
  const showRecs = tier === 'wide'
  const cols: Col[] = [
    { head: 'Date', align: 'l', min: 10, drop: 6 },
    { head: 'Session', align: 'l', min: 8 },
    ...(showRepo ? [{ head: 'Repo', align: 'l' as const, drop: 3 }] : []),
    { head: 'Hours', align: 'r', drop: 5 },
    { head: 'Turns', align: 'r', drop: 4 },
    ...(showAgents ? [{ head: 'Agents', align: 'r' as const, drop: 2 }] : []),
    { head: 'Cost', align: 'r' },
    ...(showRecs ? [{ head: 'Recs', align: 'r' as const, drop: 1 }] : []),
  ]
  const rows = listed.map(s => {
    const date = openedText(s.openedAt, rollup.zone).slice(0, 10)
    return [
      tier === 'narrow' ? date.slice(5) : date,
      id8Text(s.id8),
      ...(showRepo ? [s.repoKey === null ? '-' : oneLine(s.repoKey, 18)] : []),
      hours(s.engagedS),
      String(count(s.turns)),
      ...(showAgents ? [String(count(s.agentCount))] : []),
      sessionCost(s),
      ...(showRecs ? [String(count(s.recCount))] : []),
    ]
  })
  out.push('', ...fitTable(cols, rows, w))
  const more = all.length - listed.length
  if (more > 0) out.push(...wrapText(`${more} more — ${opts.hasMore ? 'press More or ' : ''}/rd session <id8>`, w, 2))
  else out.push(...wrapText('open one with /rd session <id8>', w, 2))
  return out.map(l => fit(l, w)).join('\n')
}

/** One option per listed session for the Sessions view's picker: the full id as the value. */
export const sessionOptions = (rollup: Rollup, shown: number, width = 60): { value: string; label: string }[] =>
  rollup.sessions.slice(0, shownRows(shown)).map(s => {
    // The id and the cost lead when the picker is narrow; the date and repository fill what is left.
    const rest = `${openedText(s.openedAt, rollup.zone).slice(0, 10)} ${s.repoKey === null ? '' : oneLine(s.repoKey, 18)}`
    const full = oneLine(`${openedText(s.openedAt, rollup.zone).slice(0, 10)} ${id8Text(s.id8)} ${s.repoKey === null ? '' : oneLine(s.repoKey, 18)} ${sessionCost(s)}`, 60)
    const w = Math.min(60, widthOf(width))
    return { value: s.sessionId, label: len(full) <= w ? full : fit(`${id8Text(s.id8)} ${sessionCost(s)} ${rest}`, w) }
  })
