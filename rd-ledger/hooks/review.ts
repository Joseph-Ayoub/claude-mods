// rd-ledger: the weekly review file (SPEC §3.4). The READ side is lead-owned
// and complete: decode with validation, the latest confirmed revision, row
// status against the live rollup. The WRITE side (confirm, reopen, notes,
// other hours, encode) is workstream W2's; its signatures are the contract.
// Pure: no `$`, no I/O.

import type { Activity, ConfirmedRow, ReviewFile, ReviewRevision, ReviewStatus, RowStatus, UnionParams } from '../types'
import { sha256 } from './hash'
import { isActivity } from './mapping'
import { cleanField, hasOwn, isDate, isId, isRedacted, isWeek, oneLine } from './text'
import { CAP, IGNORED, NON_RD, UNMAPPED } from './store'

const isRecordObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)

export const emptyReview = (week: string): ReviewFile => ({ v: 1, week, revisions: [] })

const decodeParams = (x: unknown): UnionParams | null => {
  if (!isRecordObject(x)) return null
  const gapS = num(x['gapS'])
  const floorS = num(x['floorS'])
  const maxBlockS = num(x['maxBlockS'])
  const dayFlagH = num(x['dayFlagH'])
  return gapS === null || floorS === null || maxBlockS === null || dayFlagH === null ? null : { gapS, floorS, maxBlockS, dayFlagH }
}

const decodeRow = (x: unknown, isBucketKey: boolean): ConfirmedRow | null => {
  if (!isRecordObject(x)) return null
  const seconds = num(x['seconds'])
  const entity = x['entity']
  // A frozen `__unmapped__` or `__ignored__` row carries no entity (entity ''); every other row names one (SPEC §3.4).
  const entityOk = typeof entity === 'string' && (isId(entity) || (entity === '' && isBucketKey))
  if (seconds === null || seconds < 0 || !entityOk || !isActivity(x['activity'])) return null
  return { seconds: Math.floor(seconds), entity: entity as string, activity: x['activity'], poe: x['poe'] === true, source: x['source'] === 'confirmed' ? 'confirmed' : 'pretag' }
}

const decodeRevision = (x: unknown): ReviewRevision | null => {
  if (!isRecordObject(x)) return null
  const rev = num(x['rev'])
  const at = num(x['at'])
  const params = decodeParams(x['params'])
  if (rev === null || rev < 1 || at === null || params === null) return null
  const kind = x['kind'] === 'reopen' ? 'reopen' : x['kind'] === 'confirm' ? 'confirm' : null
  if (kind === null) return null
  const rows: Record<string, ConfirmedRow> = {}
  if (isRecordObject(x['rows'])) {
    for (const [key, value] of Object.entries(x['rows'])) {
      const component = key.slice(0, key.indexOf('|'))
      const row = decodeRow(value, component === UNMAPPED || component === IGNORED)
      if (row && /^[^|]+\|\d{4}-\d{2}-\d{2}$/.test(key)) rows[key] = row
    }
  }
  const otherHours: Record<string, number | null> = {}
  if (isRecordObject(x['otherHours'])) {
    for (const [key, value] of Object.entries(x['otherHours'])) if (isId(key) || key === 'non_business') otherHours[key] = value === null ? null : (num(value) !== null && (num(value) as number) >= 0 && (num(value) as number) <= 168 ? (num(value) as number) : null)
  }
  const notes: Record<string, string> = {}
  if (isRecordObject(x['notes'])) {
    for (const [key, value] of Object.entries(x['notes'])) {
      const text = cleanField(typeof value === 'string' ? value : null, CAP.note).value
      if (text !== null && /^[^|]+\|\d{4}-W\d{2}$/.test(key)) notes[key] = text
    }
  }
  const lag = num(x['confirmedLagDays'])
  return {
    rev: Math.floor(rev),
    at,
    kind,
    confirmedAt: num(x['confirmedAt']),
    method: cleanField(typeof x['method'] === 'string' ? x['method'] : null, 40).value ?? '',
    params,
    zone: cleanField(typeof x['zone'] === 'string' ? x['zone'] : null, 64).value ?? '',
    mappingDigest: typeof x['mappingDigest'] === 'string' && /^[0-9a-f]{64}$/.test(x['mappingDigest']) ? x['mappingDigest'] : '',
    inputsDigest: typeof x['inputsDigest'] === 'string' && /^[0-9a-f]{64}$/.test(x['inputsDigest']) ? x['inputsDigest'] : '',
    rows,
    otherHours,
    notes,
    confirmedLagDays: lag === null ? null : Math.floor(lag),
  }
}

/**
 * The review file from its text (null → empty). Never throws. Revisions must
 * have strictly increasing `rev` numbers: the first revision that repeats or
 * goes backwards, and everything after it, is dropped and named in `problems`
 * (DBM-11). A `v` other than 1 or a week mismatch returns an empty file with
 * `readOnly: true` (the file must not be rewritten).
 */
export const loadReview = (text: string | null, week: string): { review: ReviewFile; problems: string[]; readOnly: boolean } => {
  if (text === null) return { review: emptyReview(week), problems: [], readOnly: false }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { review: emptyReview(week), problems: ['unparseable'], readOnly: true }
  }
  if (!isRecordObject(raw) || raw['v'] !== 1 || raw['week'] !== week || !isWeek(week)) return { review: emptyReview(week), problems: ['wrong version or week'], readOnly: true }
  const problems: string[] = []
  const revisions: ReviewRevision[] = []
  let last = 0
  if (Array.isArray(raw['revisions'])) {
    for (const [i, item] of raw['revisions'].entries()) {
      const rev = decodeRevision(item)
      if (!rev) {
        problems.push(`revision ${i} malformed`)
        continue
      }
      if (rev.rev <= last) {
        problems.push(`revision ${i} repeats or goes backwards (rev ${rev.rev} after ${last}); it and later ones ignored`)
        break
      }
      last = rev.rev
      revisions.push(rev)
    }
  }
  return { review: { v: 1, week, revisions }, problems, readOnly: false }
}

/** The latest revision of kind `confirm` not followed by a `reopen`; null when the week is open. */
export const latestConfirmed = (r: ReviewFile): ReviewRevision | null => {
  const last = r.revisions[r.revisions.length - 1]
  return last && last.kind === 'confirm' ? last : null
}

/** The latest revision of any kind (its notes and other hours carry forward as drafts). */
export const latestRevision = (r: ReviewFile): ReviewRevision | null => r.revisions[r.revisions.length - 1] ?? null

export const reviewStatus = (r: ReviewFile, changedRows: number): ReviewStatus => {
  const confirmed = latestConfirmed(r)
  return { week: r.week, confirmed: confirmed !== null, rev: latestRevision(r)?.rev ?? 0, changedRows }
}

/**
 * A live row's status against the latest confirmed revision: `pretag` with
 * no confirmation, `confirmed` when the frozen seconds and entity match the
 * live ones, `changed` otherwise (a remap, a zone or parameter change, or a
 * late event); a frozen row that no longer exists live is reported by the
 * caller as `changed` too.
 */
export const rowStatus = (confirmed: ReviewRevision | null, key: string, liveSeconds: number, liveEntity: string): { status: RowStatus; activity: Activity | null; poe: boolean | null; confirmedSeconds: number | null } => {
  if (!confirmed) return { status: 'pretag', activity: null, poe: null, confirmedSeconds: null }
  const row = Object.prototype.hasOwnProperty.call(confirmed.rows, key) ? confirmed.rows[key] : undefined
  if (!row) return { status: 'changed', activity: null, poe: null, confirmedSeconds: null }
  const same = row.seconds === liveSeconds && row.entity === liveEntity
  return { status: same ? 'confirmed' : 'changed', activity: row.activity, poe: row.poe, confirmedSeconds: row.seconds }
}

/** Keys of frozen rows absent from the live set (DBM-1: shown, never dropped). */
export const missingLiveRows = (confirmed: ReviewRevision | null, liveKeys: ReadonlySet<string>): string[] =>
  confirmed ? Object.keys(confirmed.rows).filter(k => !liveKeys.has(k)) : []

// ---------------------------------------------------------------------------------
// W2 — the write side. Implement exactly these exported names and signatures.
// ---------------------------------------------------------------------------------

export type ConfirmInput = {
  at: number
  method: string
  params: UnionParams
  zone: string
  mappingDigest: string
  inputsDigest: string
  /** The live week rows with the drafts applied: key → row */
  rows: Record<string, ConfirmedRow>
  otherHours: Record<string, number | null>
  notes: Record<string, string>
  /** The week's Sunday as `YYYY-MM-DD` (for the lag) */
  weekEnd: string
}

const DAY_MS = 86_400_000
const HEX64 = /^[0-9a-f]{64}$/
/** The key shapes loadReview keeps; a revision built here must survive its own reload unchanged. */
const ROW_KEY = /^[^|]+\|\d{4}-\d{2}-\d{2}$/
const NOTE_KEY = /^[^|]+\|\d{4}-W\d{2}$/
/** The allocation buckets that are frozen with the week but are not components (no POE, entity '' when unmapped or ignored). */
const BUCKETS: readonly string[] = [UNMAPPED, IGNORED, NON_RD]

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
/** An outside string as a refusal may show it: one clean short line, a token redacted. */
const shown = (s: string): string => cleanField(String(s), 64).value ?? '(empty)'

/** Days since 1970-01-01 of a real calendar date, or null (Date.UTC alone would roll 02-31 into March). */
const dayNumber = (date: string): number | null => {
  if (typeof date !== 'string' || !isDate(date)) return null
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const first = Date.UTC(y, m - 1, 1) / DAY_MS
  return d > Date.UTC(y, m, 1) / DAY_MS - first ? null : first + d - 1
}

/** The day number of the Sunday that ends ISO week `week` (week 1 is the one holding January 4). */
const isoWeekSunday = (week: string): number => {
  const jan4 = Date.UTC(Number(week.slice(0, 4)), 0, 4) / DAY_MS
  // Day 0 (1970-01-01) was a Thursday: with Monday as 0 that is 3.
  const monday = jan4 - ((((jan4 + 3) % 7) + 7) % 7)
  return monday + 7 * (Number(week.slice(6)) - 1) + 6
}

const copyRow = (row: ConfirmedRow): ConfirmedRow => ({ seconds: row.seconds, entity: row.entity, activity: row.activity, poe: row.poe, source: row.source })

/** A table with its keys in sorted order, values mapped; `bare` gives a null-prototype object for the encoder. */
const sortedTable = <A, B>(table: Record<string, A>, f: (a: A) => B, bare = false): Record<string, B> => {
  const out: Record<string, B> = bare ? (Object.create(null) as Record<string, B>) : {}
  for (const key of Object.keys(table).sort()) out[key] = f(table[key] as A)
  return out
}

/** A deep copy: a built file never shares a row, a note or a parameter object with the file it came from. */
const copyRevision = (x: ReviewRevision, bare = false): ReviewRevision => ({
  rev: x.rev,
  at: x.at,
  kind: x.kind,
  confirmedAt: x.confirmedAt ?? null,
  method: x.method,
  params: { gapS: x.params.gapS, floorS: x.params.floorS, maxBlockS: x.params.maxBlockS, dayFlagH: x.params.dayFlagH },
  zone: x.zone,
  mappingDigest: x.mappingDigest,
  inputsDigest: x.inputsDigest,
  rows: sortedTable(x.rows, copyRow, bare),
  otherHours: sortedTable(x.otherHours, v => v ?? null, bare),
  notes: sortedTable(x.notes, v => v, bare),
  confirmedLagDays: x.confirmedLagDays ?? null,
})

/**
 * CONTRACT (W2). A new file with a `confirm` revision appended: rev = last + 1,
 * `confirmedAt = at`, `confirmedLagDays` = whole days from the week's Sunday
 * 23:59:59 to `at` (0 when confirmed within the week), rows copied, notes
 * through `cleanField(…, CAP.note)`, other hours validated (0–168 or null).
 * Refused (`{ refused }`) when a row has `poe: true` without a non-empty note
 * for its `${component}|${week}` (PRV-3), or when a row's seconds are negative.
 * Never mutates.
 *
 * Also refused, because a frozen record that loadReview would partly drop is
 * worse than no record: a `weekEnd` that is not this week's Sunday, a missing
 * method, zone, parameter or digest, a row key or entity loadReview rejects,
 * POE on an `__unmapped__`/`__ignored__`/`__non_rd__` bucket, and POE whose
 * note the leak scan withheld (a `[redacted:…]` marker is not a justification).
 * Notes for other weeks are left out; seconds are floored.
 */
export const buildConfirm = (r: ReviewFile, input: ConfirmInput): { review: ReviewFile } | { refused: string } => {
  if (!isWeek(r.week)) return { refused: 'the review file names no valid week' }
  if (typeof input.at !== 'number' || !Number.isFinite(input.at)) return { refused: 'the confirmation time is not a number' }
  const endDay = dayNumber(input.weekEnd)
  if (endDay === null || endDay !== isoWeekSunday(r.week)) return { refused: `the week end ${oneLine(String(input.weekEnd), 20)} is not the Sunday of ${r.week}` }
  const p = input.params
  const params = { gapS: p?.gapS, floorS: p?.floorS, maxBlockS: p?.maxBlockS, dayFlagH: p?.dayFlagH }
  if (!Object.values(params).every(n => typeof n === 'number' && Number.isFinite(n))) return { refused: 'the method parameters are incomplete' }
  const method = cleanField(typeof input.method === 'string' ? input.method : null, 40).value
  const zone = cleanField(typeof input.zone === 'string' ? input.zone : null, 64).value
  if (method === null || zone === null) return { refused: 'the method or the time zone is missing' }
  if (!HEX64.test(String(input.mappingDigest)) || !HEX64.test(String(input.inputsDigest))) return { refused: 'a digest is missing' }

  const notes: Record<string, string> = {}
  for (const key of Object.keys(input.notes ?? {}).sort()) {
    if (!NOTE_KEY.test(key) || !key.endsWith(`|${r.week}`)) continue
    const text = input.notes[key]
    const value = cleanField(typeof text === 'string' ? text : null, CAP.note).value
    if (value !== null) notes[key] = value
  }

  const rows: Record<string, ConfirmedRow> = {}
  for (const key of Object.keys(input.rows ?? {}).sort()) {
    if (!ROW_KEY.test(key)) return { refused: `row ${shown(key)} is not keyed component|date` }
    const row = input.rows[key] as Partial<ConfirmedRow> | undefined
    const component = key.slice(0, key.lastIndexOf('|'))
    const bucket = BUCKETS.includes(component)
    const what = `${shown(component)} on ${key.slice(-10)}`
    if (!bucket && !isId(component)) return { refused: `row ${what} does not name a component` }
    if (typeof row?.seconds !== 'number' || !Number.isFinite(row.seconds)) return { refused: `${what} has no seconds` }
    if (row.seconds < 0) return { refused: `${what} has negative seconds` }
    const entity = row.entity
    const entityOk = typeof entity === 'string' && (isId(entity) || (entity === '' && (component === UNMAPPED || component === IGNORED)))
    if (!entityOk) return { refused: `${what} has no valid entity` }
    if (!isActivity(row.activity)) return { refused: `${what} has no valid activity` }
    if (row.poe === true) {
      if (bucket) return { refused: `${what} is not a component, so POE cannot be on` }
      const noteKey = `${component}|${r.week}`
      const note = hasOwn(notes, noteKey) ? notes[noteKey] : undefined
      if (note === undefined) return { refused: `POE for ${shown(component)} needs a note for ${r.week}` }
      if (isRedacted(note)) return { refused: `the note for ${shown(component)} held a credential or an address and was withheld; rewrite it before turning POE on` }
    }
    rows[key] = { seconds: Math.floor(row.seconds), entity: entity as string, activity: row.activity, poe: row.poe === true, source: row.source === 'confirmed' ? 'confirmed' : 'pretag' }
  }

  const otherHours: Record<string, number | null> = {}
  for (const key of Object.keys(input.otherHours ?? {}).sort()) {
    if (!isId(key) && key !== 'non_business') continue
    const h = input.otherHours[key]
    otherHours[key] = typeof h === 'number' && Number.isFinite(h) && h >= 0 && h <= 168 ? h : null
  }

  // The lag counts whole days past Sunday 23:59:59.999 in UTC terms of the date string; never negative.
  const confirmedLagDays = Math.max(0, Math.floor((input.at - ((endDay + 1) * DAY_MS - 1)) / DAY_MS))
  const revision: ReviewRevision = {
    rev: (latestRevision(r)?.rev ?? 0) + 1,
    at: input.at,
    kind: 'confirm',
    confirmedAt: input.at,
    method,
    params: params as UnionParams,
    zone,
    mappingDigest: input.mappingDigest,
    inputsDigest: input.inputsDigest,
    rows,
    otherHours,
    notes,
    confirmedLagDays,
  }
  return { review: { v: 1, week: r.week, revisions: [...r.revisions.map(x => copyRevision(x)), revision] } }
}

/**
 * CONTRACT (W2). A new file with a `reopen` revision appended (rev = last + 1, rows/notes/otherHours copied from the latest revision, `confirmedAt: null`). Refused when the week is not confirmed.
 * The method, zone and digests are carried from the confirmation being reopened; `confirmedLagDays` is null (a reopen confirms nothing).
 */
export const buildReopen = (r: ReviewFile, at: number): { review: ReviewFile } | { refused: string } => {
  const confirmed = latestConfirmed(r)
  if (!confirmed) return { refused: 'the week is not confirmed, so there is nothing to reopen' }
  if (typeof at !== 'number' || !Number.isFinite(at)) return { refused: 'the reopen time is not a number' }
  const revision: ReviewRevision = { ...copyRevision(confirmed), rev: confirmed.rev + 1, at, kind: 'reopen', confirmedAt: null, confirmedLagDays: null }
  return { review: { v: 1, week: r.week, revisions: [...r.revisions.map(x => copyRevision(x)), revision] } }
}

/**
 * CONTRACT (W2). The file text to write (two-space JSON, keys in a fixed order).
 * Fields in the type's order, table keys sorted (a re-encode never reorders a diff), every nullable written as null,
 * a trailing newline.
 */
export const encodeReview = (r: ReviewFile): string => {
  const out = { v: 1, week: r.week, revisions: r.revisions.map(x => copyRevision(x, true)) }
  return `${JSON.stringify(out, null, 2)}\n`
}

/**
 * CONTRACT (W2). An other-hours field value parsed: '' → null; a number 0–168 (one decimal) → the number; anything else → `{ error }`.
 * Plain decimal digits only (no sign, exponent or comma); rounded half up to one decimal on the digits themselves, so
 * binary floating point cannot round 7.55 down; the range is checked after rounding. The error never echoes the input.
 */
export const parseOtherHours = (text: string): number | null | { error: string } => {
  const t = String(text ?? '').trim()
  if (t === '') return null
  const m = /^(\d{1,4})(?:\.(\d{1,6}))?$/.exec(t.startsWith('.') ? `0${t}` : t)
  if (!m) return { error: 'Enter hours as a number from 0 to 168, or leave it blank' }
  const frac = m[2] ?? ''
  const tenths = Number(m[1]) * 10 + Number(frac[0] ?? '0') + (Number(frac[1] ?? '0') >= 5 ? 1 : 0)
  if (tenths > 1680) return { error: 'A week has at most 168 hours' }
  return tenths / 10
}

/** CONTRACT (W2). sha256 over the sorted admitted events in scope, each as `ts|sessionId|seg|seq`, joined by newlines (the inputs digest of a confirmation). */
export const inputsDigest = (events: readonly { ts: number; sessionId: string; seg: string; seq: number }[]): string => {
  const sorted = [...events].sort((a, b) => a.ts - b.ts || cmp(a.sessionId, b.sessionId) || cmp(a.seg, b.seg) || a.seq - b.seq)
  return sha256(sorted.map(e => `${e.ts}|${e.sessionId}|${e.seg}|${e.seq}`).join('\n'))
}
