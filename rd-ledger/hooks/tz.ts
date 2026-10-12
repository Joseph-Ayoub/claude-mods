// rd-ledger: zone math (SPEC §4.1, ADR-005). Workstream W1. Pure; `Intl` is the
// only dependency and is injectable so its absence can be tested (TES-9).
//
// Calendar arithmetic runs on whole day numbers (days since 1970-01-01) so no
// `Date` object and no clock is ever involved; only the wall-clock reading of
// an instant in a zone needs `Intl`. Local midnights are found by asking the
// zone, never by adding 86,400 s, so DST days come out 23 h and 25 h (the
// rd-tracker `instant` rule: never subtract wall clocks, timeline.py 309-327).

const DAY_MS = 86_400_000

/** Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's days_from_civil). */
const daysFromCivil = (y: number, m: number, d: number): number => {
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146_097 + doe - 719_468
}

/** The date of a day number (Hinnant's civil_from_days). */
const civilFromDays = (z0: number): { y: number; m: number; d: number } => {
  const z = z0 + 719_468
  const era = Math.floor(z / 146_097)
  const doe = z - era * 146_097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp + (mp < 10 ? 3 : -9)
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d }
}

const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0')
const fmtDate = (c: { y: number; m: number; d: number }): string => `${c.y < 0 ? '-' : ''}${pad(c.y, 4)}-${pad(c.m)}-${pad(c.d)}`

/** A `YYYY-MM-DD` string as numbers; null when it is not a real calendar date. */
const parseDate = (date: string): { y: number; m: number; d: number } | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const c = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) }
  const back = civilFromDays(daysFromCivil(c.y, c.m, c.d))
  return back.y === c.y && back.m === c.m && back.d === c.d ? c : null
}

const dayNumber = (date: string): number => {
  const c = parseDate(date)
  if (!c) throw new RangeError(`not a calendar date: ${date.slice(0, 20)}`)
  return daysFromCivil(c.y, c.m, c.d)
}

/** ISO weekday, Monday 1 … Sunday 7, of a day number (1970-01-01 was a Thursday). */
const isoWeekday = (days: number): number => ((((days + 3) % 7) + 7) % 7) + 1

// Building a DateTimeFormat costs far more than using one, and the union asks
// for a local date per block and per event, so one formatter per zone is kept.
// The cache never changes an answer, only how fast it comes.
const formatters = new Map<string, Intl.DateTimeFormat>()
const formatterFor = (zone: string): Intl.DateTimeFormat => {
  const known = formatters.get(zone)
  if (known) return known
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', era: 'short' })
  if (formatters.size >= 32) formatters.clear()
  formatters.set(zone, f)
  return f
}

type Wall = { y: number; m: number; d: number; hh: number; mm: number; ss: number }

/** The wall clock of the whole-second instant `ts` (ms) in `zone`. */
const wallOf = (ts: number, zone: string): Wall => {
  const parts = formatterFor(zone).formatToParts(Math.floor(ts / 1000) * 1000)
  const get = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? NaN)
  const era = parts.find(p => p.type === 'era')?.value ?? 'AD'
  const year = get('year')
  const wall = { y: era === 'BC' || era === 'B' ? 1 - year : year, m: get('month'), d: get('day'), hh: get('hour') % 24, mm: get('minute'), ss: get('second') }
  if (![wall.y, wall.m, wall.d, wall.hh, wall.mm, wall.ss].every(Number.isFinite)) throw new RangeError('the zone answered no usable wall clock')
  return wall
}

/** The zone's offset from UTC at `ts`, in ms (local = UTC + offset). */
const offsetAt = (ts: number, zone: string): number => {
  const w = wallOf(ts, zone)
  const wallMs = daysFromCivil(w.y, w.m, w.d) * DAY_MS + ((w.hh * 60 + w.mm) * 60 + w.ss) * 1000
  return wallMs - Math.floor(ts / 1000) * 1000
}

/** CONTRACT (W1). The local calendar date `YYYY-MM-DD` of `ts` (ms) in `zone`. */
export const localDate = (ts: number, zone: string): string => {
  const w = wallOf(ts, zone)
  return fmtDate(w)
}

/**
 * The first instant of `date` in `zone` (ms). Python's zoneinfo, which
 * rd-tracker's `local_midnight` uses, reads a wall time with the offset in
 * force before a transition (fold 0): an ambiguous midnight is its first
 * occurrence and a skipped midnight becomes the transition instant, which is
 * also the first instant of that local day. Both candidates are tried in
 * order and the first whose local date is `date` wins.
 */
const startOfDay = (date: string, zone: string): number => {
  const wall = dayNumber(date) * DAY_MS
  const before = wall - offsetAt(wall - DAY_MS, zone)
  const after = wall - offsetAt(wall + DAY_MS, zone)
  const exact = [before, after].filter(t => {
    const w = wallOf(t, zone)
    return fmtDate(w) === date && w.hh === 0 && w.mm === 0 && w.ss === 0
  })
  if (exact.length > 0) return Math.min(...exact)
  return localDate(before, zone) === date ? before : after
}

/** CONTRACT (W1). The ms instants of local midnight starting `date` and local midnight starting the next day (DST-aware; 23/24/25 h). */
export const dayBounds = (date: string, zone: string): { startTs: number; endTs: number } => ({ startTs: startOfDay(date, zone), endTs: startOfDay(addDays(date, 1), zone) })

/** CONTRACT (W1). The ISO week `YYYY-Www` of a calendar date. */
export const isoWeek = (date: string): string => {
  const days = dayNumber(date)
  // The ISO week belongs to the year of its Thursday.
  const thursday = days + 4 - isoWeekday(days)
  const year = civilFromDays(thursday).y
  const week = Math.floor((thursday - daysFromCivil(year, 1, 1)) / 7) + 1
  return `${pad(year, 4)}-W${pad(week)}`
}

/** CONTRACT (W1). Monday to Sunday of an ISO week, as dates. */
export const weekDates = (week: string): string[] => {
  const match = /^(\d{4})-W(\d{2})$/.exec(week)
  if (!match) return []
  const year = Number(match[1])
  const n = Number(match[2])
  // 4 January is always in week 1.
  const jan4 = daysFromCivil(year, 1, 4)
  const monday = jan4 - (isoWeekday(jan4) - 1) + (n - 1) * 7
  const dates = Array.from({ length: 7 }, (_, i) => fmtDate(civilFromDays(monday + i)))
  // A week 53 in a 52-week year (or week 00) is not a week: refuse rather than roll over.
  return n >= 1 && isoWeek(dates[0] as string) === week ? dates : []
}

/** CONTRACT (W1). The ISO week of `ts` in `zone`. */
export const weekOfTs = (ts: number, zone: string): string => isoWeek(localDate(ts, zone))

/** CONTRACT (W1). `YYYY-MM` of `ts` in `zone`. */
export const monthOfTs = (ts: number, zone: string): string => localDate(ts, zone).slice(0, 7)

/** CONTRACT (W1). The previous month of `YYYY-MM`. */
export const previousMonth = (month: string): string => {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) throw new RangeError(`not a month: ${month.slice(0, 20)}`)
  const y = Number(match[1])
  const m = Number(match[2])
  return m <= 1 ? `${pad(y - 1, 4)}-12` : `${pad(y, 4)}-${pad(m - 1)}`
}

/** CONTRACT (W1). `date` plus `days` (may be negative), as a date. */
export const addDays = (date: string, days: number): string => fmtDate(civilFromDays(dayNumber(date) + Math.trunc(days)))

/** CONTRACT (W1). ISO 8601 with the zone's offset at that instant, e.g. `2026-10-11T09:00:00-04:00`. */
export const isoWithOffset = (ts: number, zone: string): string => {
  const w = wallOf(ts, zone)
  const minutes = Math.round(offsetAt(ts, zone) / 60_000)
  const sign = minutes < 0 ? '-' : '+'
  return `${fmtDate(w)}T${pad(w.hh)}:${pad(w.mm)}:${pad(w.ss)}${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`
}

/** One line, ASCII, no spaces, ≤ 64: the only shape an IANA name (or `UTC`) takes. */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/

// A default parameter would treat an explicit `undefined` as "use the default",
// so `detectZone(undefined)` would read the real Intl. The argument count
// decides instead: no argument means the runtime's Intl, an explicit undefined
// means Intl is absent. The call type is unchanged: `(intl?: typeof Intl)`.
const intlArg = (args: readonly unknown[]): typeof Intl | undefined => (args.length === 0 ? globalThis.Intl : (args[0] as typeof Intl | undefined))

/** CONTRACT (W1). The runtime's zone, or null when `Intl` (injected for tests) is missing, throws, or answers nothing usable. */
export const detectZone = (...args: [intl?: typeof Intl | undefined]): string | null => {
  const intl = intlArg(args)
  if (!intl) return null
  try {
    const zone: unknown = new intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && isZone(zone, intl) ? zone : null
  } catch {
    return null
  }
}

/** CONTRACT (W1). Whether `Intl` accepts the name as a time zone (and it is one line, ≤ 64 ASCII chars, no spaces). */
export const isZone = (name: string, ...args: [intl?: typeof Intl | undefined]): boolean => {
  const intl = intlArg(args)
  if (typeof name !== 'string' || name.length === 0 || name.length > 64 || !ZONE_SHAPE.test(name) || !intl) return false
  try {
    new intl.DateTimeFormat('en-US', { timeZone: name })
    return true
  } catch {
    return false
  }
}

/** CONTRACT (W1). The zone named by a `/etc/localtime` link target such as `/var/db/timezone/zoneinfo/America/New_York`, or null. */
export const zoneFromLocaltimeTarget = (target: string): string | null => {
  if (typeof target !== 'string' || target.length > 512 || /[\r\n\0]/.test(target)) return null
  const marker = '/zoneinfo/'
  const at = target.lastIndexOf(marker)
  if (at < 0) return null
  let name = target.slice(at + marker.length)
  // The posix/ and right/ trees hold the same zones under another root.
  if (name.startsWith('posix/')) name = name.slice('posix/'.length)
  else if (name.startsWith('right/')) name = name.slice('right/'.length)
  return isZone(name) ? name : null
}
