import { describe, expect, test } from 'claude-code/testing'

import type { ConfirmedRow, ReviewFile, ReviewRevision } from '../types'
import { sha256 } from './hash'
import type { ConfirmInput } from './review'
import { buildConfirm, buildReopen, emptyReview, encodeReview, inputsDigest, latestConfirmed, latestRevision, loadReview, missingLiveRows, parseOtherHours, reviewStatus, rowStatus } from './review'

const rev = (n: number, kind: 'confirm' | 'reopen', rows: ReviewRevision['rows'] = {}): ReviewRevision => ({
  rev: n, at: 1000 + n, kind, confirmedAt: kind === 'confirm' ? 1000 + n : null, method: 'union-v2/a5db146c', params: { gapS: 1800, floorS: 60, maxBlockS: 14400, dayFlagH: 14 }, zone: 'America/New_York',
  mappingDigest: 'a'.repeat(64), inputsDigest: 'b'.repeat(64), rows, otherHours: { acme: 7, non_business: null }, notes: { 'acme-app|2026-W41': 'tried x' }, confirmedLagDays: 0,
})
const file = (...revs: ReviewRevision[]): ReviewFile => ({ v: 1, week: '2026-W41', revisions: revs })

describe('review read side', () => {
  test('load: empty, round trip, strictly increasing revs, malformed rows, wrong week', async () => {
    expect(loadReview(null, '2026-W41')).toEqual({ review: { v: 1, week: '2026-W41', revisions: [] }, problems: [], readOnly: false })
    const f = file(rev(1, 'confirm', { 'acme-app|2026-10-11': { seconds: 1980, entity: 'acme', activity: 'direct_research', poe: true, source: 'confirmed' } }), rev(2, 'reopen'))
    expect(loadReview(JSON.stringify(f), '2026-W41').review).toEqual(f)
    const bad = loadReview(JSON.stringify(file(rev(1, 'confirm'), rev(1, 'confirm'), rev(3, 'confirm'))), '2026-W41')
    expect(bad.review.revisions.map(r => r.rev)).toEqual([1])
    expect(bad.problems.length).toBe(1)
    const hostile = JSON.stringify(file({ ...rev(1, 'confirm'), rows: { 'x|2026-10-11': { seconds: -1, entity: 'acme', activity: 'direct_research', poe: true, source: 'confirmed' }, 'ok|2026-10-11': { seconds: 5.9, entity: 'acme', activity: 'direct_support', poe: 'yes', source: 'odd' }, 'bad key': { seconds: 1, entity: 'acme', activity: 'direct_support', poe: false, source: 'pretag' } }, notes: { 'acme-app|2026-W41': 'a\nb ghp_abcdefghijklmnop' }, otherHours: { acme: 200, 'non_business': 3 } }))
    const h = loadReview(hostile, '2026-W41').review.revisions[0]
    expect(h?.rows).toEqual({ 'ok|2026-10-11': { seconds: 5, entity: 'acme', activity: 'direct_support', poe: false, source: 'pretag' } })
    expect(h?.notes).toEqual({ 'acme-app|2026-W41': '[redacted:github-token]' })
    expect(h?.otherHours).toEqual({ acme: null, non_business: 3 })
    const buckets = file(rev(1, 'confirm', { '__unmapped__|2026-10-11': { seconds: 5380, entity: '', activity: 'non_qualified', poe: false, source: 'pretag' }, '__ignored__|2026-10-11': { seconds: 10, entity: '', activity: 'non_qualified', poe: false, source: 'pretag' }, 'acme-app|2026-10-11': { seconds: 1, entity: '', activity: 'direct_research', poe: false, source: 'pretag' } }))
    expect(Object.keys(loadReview(JSON.stringify(buckets), '2026-W41').review.revisions[0]?.rows ?? {})).toEqual(['__unmapped__|2026-10-11', '__ignored__|2026-10-11'])
    expect(loadReview('{"v":2}', '2026-W41')).toMatchObject({ readOnly: true })
    expect(loadReview(JSON.stringify(file()), '2026-W42')).toMatchObject({ readOnly: true })
    expect(loadReview('nope', '2026-W41')).toMatchObject({ readOnly: true, problems: ['unparseable'] })
  })
  test('latest, status and row drift', async () => {
    const c = rev(1, 'confirm', { 'acme-app|2026-10-11': { seconds: 1980, entity: 'acme', activity: 'direct_research', poe: true, source: 'confirmed' } })
    expect(latestConfirmed(file(c))).toBe(c)
    expect(latestConfirmed(file(c, rev(2, 'reopen')))).toBe(null)
    expect(latestRevision(file())).toBe(null)
    expect(reviewStatus(file(c), 2)).toEqual({ week: '2026-W41', confirmed: true, rev: 1, changedRows: 2 })
    expect(rowStatus(null, 'acme-app|2026-10-11', 1980, 'acme')).toEqual({ status: 'pretag', activity: null, poe: null, confirmedSeconds: null })
    expect(rowStatus(c, 'acme-app|2026-10-11', 1980, 'acme')).toEqual({ status: 'confirmed', activity: 'direct_research', poe: true, confirmedSeconds: 1980 })
    expect(rowStatus(c, 'acme-app|2026-10-11', 1981, 'acme').status).toBe('changed')
    expect(rowStatus(c, 'acme-app|2026-10-11', 1980, 'other').status).toBe('changed')
    expect(rowStatus(c, 'new|2026-10-11', 5, 'acme').status).toBe('changed')
    expect(missingLiveRows(c, new Set(['x|2026-10-11']))).toEqual(['acme-app|2026-10-11'])
    expect(missingLiveRows(null, new Set())).toEqual([])
  })
})

// --- W2: the write side -------------------------------------------------------------

const PARAMS = { gapS: 1800, floorS: 60, maxBlockS: 14400, dayFlagH: 14 }
const DAY = 86_400_000
/** 2026-W41 ends on Sunday 2026-10-11; this is its last millisecond in UTC terms. */
const SUNDAY_END = Date.UTC(2026, 9, 11, 23, 59, 59, 999)
const AT = Date.UTC(2026, 9, 13, 10)

const input = (over: Partial<ConfirmInput> = {}): ConfirmInput => ({
  at: AT,
  method: 'union-v2/a5db146c',
  params: { ...PARAMS },
  zone: 'America/New_York',
  mappingDigest: 'a'.repeat(64),
  inputsDigest: 'b'.repeat(64),
  rows: {
    'acme-app|2026-10-11': { seconds: 1980.7, entity: 'acme', activity: 'direct_research', poe: true, source: 'confirmed' },
    'acme-app|2026-10-10': { seconds: 600, entity: 'acme', activity: 'direct_support', poe: false, source: 'pretag' },
  },
  otherHours: { non_business: 200, acme: 7.5, 'Bad Key': 3, beta: null },
  notes: { 'acme-app|2026-W41': 'tried x\nthen y', 'acme-app|2026-W40': 'another week', 'quiet|2026-W41': '   ' },
  weekEnd: '2026-10-11',
  ...over,
})

const built = (x: { review: ReviewFile } | { refused: string }): ReviewFile => {
  if ('refused' in x) throw new Error(`unexpected refusal: ${x.refused}`)
  return x.review
}
const refusal = (x: { review: ReviewFile } | { refused: string }): string => ('refused' in x ? x.refused : '(not refused)')
const row = (over: Partial<ConfirmedRow> = {}): ConfirmedRow => ({ seconds: 60, entity: 'acme', activity: 'direct_support', poe: false, source: 'pretag', ...over })

describe('review write side', () => {
  test('confirm: rev last + 1, rows frozen and floored, notes cleaned, other hours validated, lag in whole days', async () => {
    const r0 = emptyReview('2026-W41')
    const i = input()
    const snapshot = JSON.stringify(i)
    const f = built(buildConfirm(r0, i))
    expect(JSON.stringify(i)).toBe(snapshot)
    expect(r0.revisions).toEqual([])
    expect(f.revisions).toEqual([
      {
        rev: 1,
        at: AT,
        kind: 'confirm',
        confirmedAt: AT,
        method: 'union-v2/a5db146c',
        params: PARAMS,
        zone: 'America/New_York',
        mappingDigest: 'a'.repeat(64),
        inputsDigest: 'b'.repeat(64),
        rows: {
          'acme-app|2026-10-10': { seconds: 600, entity: 'acme', activity: 'direct_support', poe: false, source: 'pretag' },
          'acme-app|2026-10-11': { seconds: 1980, entity: 'acme', activity: 'direct_research', poe: true, source: 'confirmed' },
        },
        otherHours: { acme: 7.5, beta: null, non_business: null },
        notes: { 'acme-app|2026-W41': 'tried x then y' },
        confirmedLagDays: 1,
      },
    ])
    expect(f.revisions[0]!.params === i.params).toBe(false)
    expect(latestConfirmed(f)).toBe(f.revisions[0]!)
    const lag = (at: number): number | null => built(buildConfirm(r0, input({ at }))).revisions[0]!.confirmedLagDays
    expect(lag(Date.UTC(2026, 9, 8))).toBe(0)
    expect(lag(SUNDAY_END)).toBe(0)
    expect(lag(SUNDAY_END + 1)).toBe(0)
    expect(lag(SUNDAY_END + DAY - 1)).toBe(0)
    expect(lag(SUNDAY_END + DAY)).toBe(1)
    expect(lag(SUNDAY_END + 30 * DAY + 5)).toBe(30)
    // The buckets are frozen with the week: unmapped and ignored carry entity '', non-R&D its entity.
    const buckets = built(buildConfirm(r0, input({ rows: { '__unmapped__|2026-10-10': row({ entity: '', activity: 'non_qualified' }), '__ignored__|2026-10-09': row({ entity: '' }), '__non_rd__|2026-10-09': row({ activity: 'non_qualified' }) } })))
    expect(Object.keys(buckets.revisions[0]!.rows)).toEqual(['__ignored__|2026-10-09', '__non_rd__|2026-10-09', '__unmapped__|2026-10-10'])
  })

  test('confirm refusals: POE needs a real note for that component and week; nothing negative; a whole record or none', async () => {
    const r0 = emptyReview('2026-W41')
    const cases: [ConfirmInput, string][] = [
      [input({ notes: {} }), 'POE for acme-app needs a note for 2026-W41'],
      [input({ notes: { 'acme-app|2026-W41': ' \n\t ' } }), 'POE for acme-app needs a note for 2026-W41'],
      [input({ notes: { 'acme-app|2026-W40': 'the week before' } }), 'POE for acme-app needs a note for 2026-W41'],
      [input({ notes: { 'acme-app|2026-W41': 'see ghp_abcdefghijklmnopqrstu' } }), 'the note for acme-app held a credential'],
      [input({ rows: { 'acme-app|2026-10-09': row({ seconds: -1 }) } }), 'acme-app on 2026-10-09 has negative seconds'],
      [input({ rows: { 'acme-app|2026-10-09': row({ seconds: Number.NaN }) } }), 'acme-app on 2026-10-09 has no seconds'],
      [input({ rows: { 'acme-app|2026-10-09': row({ entity: '' }) } }), 'acme-app on 2026-10-09 has no valid entity'],
      [input({ rows: { 'acme-app|2026-10-09': row({ activity: 'research' as never }) } }), 'acme-app on 2026-10-09 has no valid activity'],
      [input({ rows: { '__unmapped__|2026-10-09': row({ entity: '', poe: true }) }, notes: { '__unmapped__|2026-W41': 'x' } }), '__unmapped__ on 2026-10-09 is not a component'],
      [input({ rows: { 'Bad_Id|2026-10-09': row() } }), 'row Bad_Id on 2026-10-09 does not name a component'],
      [input({ rows: { 'no key': row() } }), 'row no key is not keyed component|date'],
      [input({ weekEnd: '2026-10-12' }), 'the week end 2026-10-12 is not the Sunday of 2026-W41'],
      [input({ weekEnd: '2026-10-04' }), 'the week end 2026-10-04 is not the Sunday of 2026-W41'],
      [input({ weekEnd: '2026-02-31' }), 'the week end 2026-02-31 is not the Sunday'],
      [input({ at: Number.NaN }), 'the confirmation time is not a number'],
      [input({ params: { ...PARAMS, gapS: Number.POSITIVE_INFINITY } }), 'the method parameters are incomplete'],
      [input({ method: '' }), 'the method or the time zone is missing'],
      [input({ zone: ' ' }), 'the method or the time zone is missing'],
      [input({ mappingDigest: 'A'.repeat(64) }), 'a digest is missing'],
      [input({ inputsDigest: '' }), 'a digest is missing'],
    ]
    for (const [i, start] of cases) expect(refusal(buildConfirm(r0, i)).startsWith(start) ? start : refusal(buildConfirm(r0, i))).toBe(start)
    expect(refusal(buildConfirm({ v: 1, week: 'nope', revisions: [] }, input()))).toBe('the review file names no valid week')
    expect(r0.revisions).toEqual([])
    // ISO week edges: 2026-W53 ends on 2027-01-03; 2027-W01 on 2027-01-10.
    expect('review' in buildConfirm(emptyReview('2026-W53'), input({ weekEnd: '2027-01-03', rows: {} }))).toBe(true)
    expect('review' in buildConfirm(emptyReview('2027-W01'), input({ weekEnd: '2027-01-10', rows: {} }))).toBe(true)
  })

  test('reopen: refused unless confirmed; copies the confirmation with confirmedAt null; numbering stays strictly increasing', async () => {
    expect(refusal(buildReopen(emptyReview('2026-W41'), 5)).startsWith('the week is not confirmed')).toBe(true)
    const f = built(buildConfirm(emptyReview('2026-W41'), input()))
    const o = built(buildReopen(f, AT + 1))
    expect(f.revisions.length).toBe(1)
    expect(o.revisions[1]).toEqual({ ...f.revisions[0]!, rev: 2, at: AT + 1, kind: 'reopen', confirmedAt: null, confirmedLagDays: null })
    expect(o.revisions[1]!.rows === f.revisions[0]!.rows).toBe(false)
    expect(o.revisions[0] === f.revisions[0]).toBe(false)
    expect(latestConfirmed(o)).toBe(null)
    expect(refusal(buildReopen(o, AT + 2)).startsWith('the week is not confirmed')).toBe(true)
    expect(refusal(buildReopen(f, Number.NaN))).toBe('the reopen time is not a number')
    const again = built(buildConfirm(o, input({ at: AT + 3 })))
    expect(again.revisions.map(x => `${x.rev}:${x.kind}`)).toEqual(['1:confirm', '2:reopen', '3:confirm'])
    expect(again.revisions[0]).toEqual(f.revisions[0]!)
    expect(reviewStatus(again, 0)).toEqual({ week: '2026-W41', confirmed: true, rev: 3, changedRows: 0 })
  })

  test('encode: fixed key order, sorted tables, trailing newline; loadReview reads it back exactly', async () => {
    const f = built(buildConfirm(built(buildReopen(built(buildConfirm(emptyReview('2026-W41'), input())), AT + 1)), input({ at: AT + 2 })))
    const text = encodeReview(f)
    expect(text.startsWith('{\n  "v": 1,\n  "week": "2026-W41",\n  "revisions": [\n    {\n      "rev": 1,')).toBe(true)
    expect(text.endsWith('}\n')).toBe(true)
    const parsed = JSON.parse(text) as { revisions: Record<string, Record<string, unknown>>[] }
    expect(Object.keys(parsed)).toEqual(['v', 'week', 'revisions'])
    expect(Object.keys(parsed.revisions[1]!)).toEqual(['rev', 'at', 'kind', 'confirmedAt', 'method', 'params', 'zone', 'mappingDigest', 'inputsDigest', 'rows', 'otherHours', 'notes', 'confirmedLagDays'])
    expect(parsed.revisions[1]!['confirmedAt']).toBe(null)
    expect(Object.keys(parsed.revisions[0]!['params'] as object)).toEqual(['gapS', 'floorS', 'maxBlockS', 'dayFlagH'])
    expect(Object.keys((parsed.revisions[0]!['rows'] as Record<string, object>)['acme-app|2026-10-11'] as object)).toEqual(['seconds', 'entity', 'activity', 'poe', 'source'])
    const back = loadReview(text, '2026-W41')
    expect(back.problems).toEqual([])
    expect(back.readOnly).toBe(false)
    expect(back.review).toEqual(f)
    expect(encodeReview(back.review)).toBe(text)
    // The lead's fixture shape round-trips too, and table insertion order never changes the bytes.
    const lead = file(rev(1, 'confirm', { 'b|2026-10-11': row(), 'a|2026-10-11': row({ poe: true }) }), rev(2, 'reopen'))
    expect(loadReview(encodeReview(lead), '2026-W41').review).toEqual(lead)
    const swapped = file(rev(1, 'confirm', { 'a|2026-10-11': row({ poe: true }), 'b|2026-10-11': row() }), rev(2, 'reopen'))
    expect(encodeReview(swapped)).toBe(encodeReview(lead))
    expect(encodeReview(emptyReview('2026-W41'))).toBe('{\n  "v": 1,\n  "week": "2026-W41",\n  "revisions": []\n}\n')
  })

  test('other hours: blank is null, one decimal rounded half up on the digits, 0 to 168, anything else an error', async () => {
    const good: [string, number | null][] = [['', null], ['  ', null], ['7', 7], ['7.5', 7.5], [' 12 ', 12], ['7.55', 7.6], ['7.549', 7.5], ['0.95', 1], ['0', 0], ['168', 168], ['168.04', 168], ['.5', 0.5], ['007', 7]]
    for (const [text, want] of good) expect(parseOtherHours(text)).toBe(want)
    for (const text of ['169', '-1', 'abc', '1e3', '168.05', '7,5', '+5', '7.', 'Infinity', 'NaN', '0x10', '1 2', '１２', '99999']) {
      const got = parseOtherHours(text)
      expect(typeof got === 'object' && got !== null && typeof got.error === 'string' && !got.error.includes(text)).toBe(true)
    }
  })

  test('inputs digest: sorted by ts, session, segment, then numeric seq; order-free; empty is the empty string', async () => {
    const A = '11111111-aaaa-4bbb-8ccc-000000000001'
    const B = '11111111-aaaa-4bbb-8ccc-000000000002'
    const e = (ts: number, sessionId: string, seg: string, seq: number) => ({ ts, sessionId, seg, seq })
    const events = [e(2000, B, 'k1', 1), e(1000, A, 'k1', 2), e(2000, A, 'k2', 0), e(2000, A, 'k1', 10), e(2000, A, 'k1', 5)]
    const lines = [`1000|${A}|k1|2`, `2000|${A}|k1|5`, `2000|${A}|k1|10`, `2000|${A}|k2|0`, `2000|${B}|k1|1`]
    expect(inputsDigest(events)).toBe(sha256(lines.join('\n')))
    expect(inputsDigest([...events].reverse())).toBe(inputsDigest(events))
    expect(events[0]).toEqual(e(2000, B, 'k1', 1))
    expect(inputsDigest([])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(inputsDigest(events)).toMatch(/^[0-9a-f]{64}$/)
  })
})
