import { describe, expect, test } from 'claude-code/testing'

import type { Allocation, Block, BridgeLogEntry, EngagementEvent, Mapping, ReviewFile, ReviewRevision, SessionRecord, TurnRecord } from '../types'
import { buildExport, buildExportWith, CAVEAT, CSV_COLUMNS, DICTIONARY, EXPORT_FILES, manifestText, SPEND_LABEL } from './exporter'
import type { ExportInput, Pricing } from './exporter'
import { D1, F1_EVENTS, F1_EXPECTED_ALLOCATIONS, F1_EXPECTED_BLOCKS, F1_MAPPING_JSON, F1_REPOS, F1_UNION_EVENTS, PARAMS, S1, S2, S3, SEG, ZONE } from './fixtures/ground-truth'
import { PRICES, PRICES_AS_OF, priceRow, priceTurn } from './prices'
import { LOG_PAGE_LINES, utcIso } from './report'
import { decodeSession, newSegment } from './store'
import { bareObject } from './text'

const METHOD = 'union-v2/a5db146c'
const S4 = '44444444-aaaa-4bbb-8ccc-000000000004'
const S5 = '55555555-aaaa-4bbb-8ccc-000000000005'
const at = (t: number) => D1 + t * 1000
const HASH: Record<string, string> = { [S1]: 'aaaaaaaaaaaa', [S2]: 'bbbbbbbbbbbb', [S3]: 'cccccccccccc', [S4]: 'dddddddddddd', [S5]: 'eeeeeeeeeeee' }
const HOSTILE_BRANCH = 'feat/x\n2026-10-11,forged,row‮\r\n=1'
const TOKEN_BRANCH = 'feat/ghp_abcdefghijklmnop'

const segment = (sessionId: string, repoKey: string, branch: string, events: EngagementEvent[], turns: TurnRecord[] = [], openedAt = D1 + 1000): SessionRecord => ({
  ...newSegment({ sessionId, openedAt, source: 'startup', entrypoint: 'claude-desktop', interactive: true, surface: 'desktop', repoKey, repoKind: 'repo', rootHash: HASH[sessionId] as string, cwdBase: repoKey, branch: null, model: 'claude-opus-5-5', engineCostAtOpen: null }),
  seg: SEG,
  // planted after newSegment so the export's own boundary is what is tested
  branch,
  events,
  turns,
  nextSeq: 100,
})
const f1Events = (sessionId: string): EngagementEvent[] =>
  F1_EVENTS.map((e, i) => ({ ...e, seq: i + 1 }))
    .filter(e => e.sessionId === sessionId)
    .map(e => ({ seq: e.seq, ts: at(e.t), origin: e.origin, admit: e.admit, reason: e.admit === 1 ? 'human' : e.origin === 'sdk' ? 'automation-entrypoint' : `origin:${e.origin}`, queued: e.queued }))
const turn = (seq: number, t: number, model: string | null): TurnRecord => ({ seq, ts: at(t), endTs: at(t + 30), turnId: `turn-${seq}`, agentKey: '', agent: 0, model, in: 1000, out: 2000, cr: 5000, cw: 400, reason: 'answer' })

const blocks = (): Block[] =>
  F1_EXPECTED_BLOCKS.map(b => ({ date: b.date, startTs: at(b.startT), endTs: at(b.endT), seconds: b.seconds, events: F1_UNION_EVENTS.filter(e => e.ts >= at(b.startT) && e.ts <= at(b.endT)).slice(0, b.eventIds.length), flags: b.flags }))
const allocations = (): Allocation[] =>
  F1_EXPECTED_ALLOCATIONS.map(a => ({ date: a.date, blockStartTs: a.date === '2026-10-11' ? at(32400) : at(86400), sessionId: a.sessionId, seg: SEG, repoRef: F1_REPOS[a.sessionId] as string, component: a.component, entity: a.component === '__unmapped__' ? '' : 'acme', seconds: a.seconds }))

const mapping = (): Mapping => ({
  v: 1,
  gen: 1,
  entities: bareObject({ acme: { name: 'Example Co', filing: 'c-corp' } }),
  components: bareObject({ 'comp-alpha': { name: 'Alpha', entity: 'acme', activity: 'direct_research', poe: true, rdt: 'comp-alpha' }, 'comp-beta': { name: 'Beta', entity: 'acme', activity: 'direct_support', poe: false, rdt: null } }),
  repos: bareObject({ alpha: { component: 'comp-alpha' }, beta: { component: 'comp-beta' }, 'private-repo': { ignore: true } }),
  pretag: [],
  extra: {},
})

const revision = (rev: number, rows: ReviewRevision['rows'], notes: Record<string, string> = {}): ReviewRevision => ({
  rev, at: D1 + 100_000_000, kind: 'confirm', confirmedAt: D1 + 100_000_000, method: METHOD, params: PARAMS, zone: ZONE, mappingDigest: 'a'.repeat(64), inputsDigest: 'b'.repeat(64), rows, otherHours: { acme: 10 }, notes, confirmedLagDays: 1,
})
const W41: ReviewFile = {
  v: 1,
  week: '2026-W41',
  revisions: [
    revision(1, {
      'comp-alpha|2026-10-11': { seconds: 1980, entity: 'acme', activity: 'direct_research', poe: true, source: 'confirmed' },
      'comp-beta|2026-10-11': { seconds: 6000, entity: 'acme', activity: 'direct_support', poe: false, source: 'pretag' },
      '__unmapped__|2026-10-11': { seconds: 5380, entity: '', activity: 'non_qualified', poe: false, source: 'pretag' },
      'comp-gone|2026-10-11': { seconds: 500, entity: 'acme', activity: 'direct_research', poe: false, source: 'confirmed' },
    }, { 'comp-alpha|2026-W41': 'tried x, unsure about y' }),
  ],
}

const PRICING: Pricing = {
  priceTurn: (t, ttl) => (t.model === 'claude-opus-5-5' ? { usd: (t.in * 4 + t.out * 20 + t.cw * 4 * (ttl === '1h' ? 2 : 1.25)) / 1e6, priced: true } : { usd: null, priced: false }),
  spendByMonth: () => [
    { month: '2026-09', model: 'claude-opus-5-5', component: 'comp-alpha', entity: 'acme', turns: 1, in: 1, out: 1, cr: 1, cw: 1, usd: 0.25, priced: true },
    { month: '2026-10', model: 'claude-opus-5-5', component: 'comp-alpha', entity: 'acme', turns: 2, in: 10, out: 20, cr: 30, cw: 40, usd: 0.5, priced: true },
    { month: '2026-10', model: '@SUM(A1)', component: '__unmapped__', entity: '', turns: 1, in: 1, out: 0, cr: 0, cw: 0, usd: null, priced: false },
  ],
}

const bridgeLog: BridgeLogEntry[] = [
  { at: D1 + 150_000_000, kind: 'sent', week: '2026-W41', rev: 1, date: '2026-10-11', rdtEntity: 'acme', rdtComponent: 'comp-alpha', hundredths: 55, argv: ['/usr/bin/python3', '-I', '-m', 'rdt', 'add', '--repo=/Users/someone/rd-tracker'], exitCode: 0, rowId: 7, label: null, lagDays: 1, stdoutLine: 'added row 7' },
]

const input = (over: Partial<ExportInput> = {}): ExportInput => ({
  scope: { year: '2026', month: '2026-10' },
  segments: [
    segment(S2, 'beta', TOKEN_BRANCH, f1Events(S2), [turn(30, 33_100, null)]),
    segment(S1, 'alpha', HOSTILE_BRANCH, f1Events(S1), [turn(40, 32_500, 'claude-opus-5-5'), turn(41, 33_000, '=HYPERLINK("x")')]),
    { ...segment(S3, 'gamma', 'personal/diary', f1Events(S3)) },
  ].map(s => (s.sessionId === S1 ? { ...s, cacheTtlChanges: [{ ts: at(32_800), ttl: '1h' as const }] } : s)),
  blocks: blocks(),
  allocations: allocations(),
  reviews: [W41],
  mapping: mapping(),
  mappingText: F1_MAPPING_JSON,
  bridgeLog,
  zone: ZONE,
  params: PARAMS,
  method: METHOD,
  defaultTtl: '5m',
  version: '0.1.0',
  now: D1 + 200_000_000,
  personLabel: '',
  sources: { unionSha256: 'a'.repeat(64), pricesSha256: 'b'.repeat(64) },
  unreadable: 0,
  admissionVersion: 'admission-v1',
  ...over,
})

const build = (over: Partial<ExportInput> = {}) => buildExportWith(input(over), PRICING)
const fileOf = (out: ReturnType<typeof build>, name: string): string => out.files.find(f => f.name === name)?.text ?? ''

/** A minimal RFC 4180 reader for one line (the export never writes a line break inside a cell). */
const cells = (line: string): string[] => {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}
const table = (text: string): Record<string, string>[] => {
  const lines = text.split('\n')
  expect(lines.pop()).toBe('')
  const header = cells(lines[0] as string)
  return lines.slice(1).map(l => Object.fromEntries(cells(l).map((c, i) => [header[i] as string, c])))
}

describe('export file set', () => {
  test('exactly the §6.4 files, in order, with the §6.4 CSV columns', async () => {
    const out = build()
    expect(out.files.map(f => f.name)).toEqual([...EXPORT_FILES])
    expect(EXPORT_FILES).toEqual(['README.md', 'method.json', 'events.csv', 'blocks.csv', 'allocations.csv', 'hours_by_component.csv', 'activity_notes.csv', 'turns.csv', 'spend_by_month.csv', 'monthly_log.txt', 'reviews.json', 'components.json', 'bridge.ndjson', 'sessions.ndjson'])
    for (const [name, columns] of Object.entries(CSV_COLUMNS)) expect(fileOf(out, name).split('\n')[0]).toBe(columns.join(','))
    expect(Object.keys(out.redactions).sort()).toEqual([...EXPORT_FILES].sort())
  })
  test('README: caveat first, PROVISIONAL while a week is open, person, sources, verbatim rules, redactions', async () => {
    const out = build()
    const readme = fileOf(out, 'README.md')
    const lines = readme.split('\n')
    expect(lines[0]).toBe(CAVEAT)
    expect(CAVEAT).toBe("Nothing in this export is tax advice; what is claimed is the CPA's decision.")
    expect(lines[2]).toMatch(/^PROVISIONAL: 1 week in scope has no confirmed review \(2026-W42\)/)
    expect(readme).toContain('Person: not recorded — add on cover sheet')
    expect(readme).toContain(`union.ts sha256: ${'a'.repeat(64)}`)
    expect(readme).toContain(`prices.ts sha256: ${'b'.repeat(64)}`)
    expect(readme).toContain('Mod version: 0.1.0')
    expect(readme).toContain('## 4. Engagement model — union-v2 parity')
    expect(readme).toContain('| origin `sdk`, entrypoint `claude-desktop`, record surface `desktop` | 1 | `human-desktop-host` |')
    expect(readme).toContain('3. Merge while `gap ≤ gapS` (1800 merges, 1801 splits).')
    expect(readme).toContain('### 3.6 Retention')
    expect(readme).toContain('| sessions.ndjson | sessionId |')
    expect(readme).toContain('| events.csv | github-token | 9 |')
    expect(readme).toContain('list-price estimate, not an invoice')
    const named = fileOf(build({ personLabel: 'Jordan Example\nInjected: line' }), 'README.md')
    expect(named).toContain('Person: Jordan Example Injected: line')
    expect(fileOf(build({ personLabel: 'me@realmail.io' }), 'README.md')).toContain('Person: [redacted:email-address]')
    const W42: ReviewFile = { v: 1, week: '2026-W42', revisions: [revision(1, {})] }
    expect(fileOf(build({ reviews: [W41, W42] }), 'README.md')).not.toContain('PROVISIONAL')
  })
})

describe('rows and privacy (PRV-4, CYB-11)', () => {
  test('events.csv: one line per event, buckets in place of unmapped names, a planted token redacted and counted', async () => {
    const out = build()
    const text = fileOf(out, 'events.csv')
    const rows = table(text)
    expect(rows.length).toBe(F1_EVENTS.length)
    // the hostile branch (newlines, CR, a bidi override) adds no line: rows + the header
    expect(text.endsWith('\n')).toBe(true)
    expect(text.slice(0, -1).split('\n').length).toBe(F1_EVENTS.length + 1)
    expect(rows[0]).toEqual({ date: '2026-10-11', ts: '2026-10-11T09:00:00-04:00', sessionId: S1, seg: SEG, seq: '1', repoKey: 'alpha', rootHash: HASH[S1] as string, branch: 'feat/x 2026-10-11,forged,row =1', origin: 'composer', admit: '1', reason: 'human', queued: '0' })
    for (const r of rows.filter(x => x.sessionId === S3)) expect([r.repoKey, r.rootHash, r.branch]).toEqual(['__unmapped__', '__unmapped__', '__unmapped__'])
    for (const r of rows.filter(x => x.sessionId === S2)) expect(r.branch).toBe('[redacted:github-token]')
    expect(rows.find(x => x.origin === 'task-notification')).toMatchObject({ admit: '0', reason: 'origin:task-notification', repoKey: '__unmapped__' })
    for (const banned of ['gamma', HASH[S3] as string, 'personal/diary', 'ghp_', '‮', '\r']) expect(text).not.toContain(banned)
    expect(out.redactions['events.csv']).toBe(9)
  })
  test('a segment with no seconds resolves through the mapping; an ignored repository shows its bucket', async () => {
    const lone = (sessionId: string, repoKey: string) => segment(sessionId, repoKey, 'main', [{ seq: 1, ts: at(40_000), origin: 'sdk', admit: 0, reason: 'automation-entrypoint', queued: 0 }])
    const rows = table(fileOf(build({ segments: [lone(S4, 'beta'), lone(S5, 'private-repo')] }), 'events.csv'))
    expect(rows.map(r => [r.sessionId, r.repoKey, r.branch])).toEqual([
      [S4, 'beta', 'main'],
      [S5, '__ignored__', '__ignored__'],
    ])
  })
  test('allocations and hours: confirmed, changed and provisional; frozen rows kept with zero live seconds', async () => {
    const out = build()
    const allocs = table(fileOf(out, 'allocations.csv'))
    expect(allocs.length).toBe(F1_EXPECTED_ALLOCATIONS.length)
    expect(allocs.find(a => a.component === 'comp-alpha' && a.date === '2026-10-11')).toEqual({ date: '2026-10-11', blockStart: '2026-10-11T09:00:00-04:00', sessionId: S1, component: 'comp-alpha', entity: 'acme', seconds: '1980', activity: 'direct_research', poe: 'true', status: 'confirmed', rev: '1' })
    expect(allocs.find(a => a.component === 'comp-beta' && a.date === '2026-10-11')).toMatchObject({ status: 'changed', rev: '1', activity: 'direct_support' })
    expect(allocs.find(a => a.component === '__unmapped__' && a.date === '2026-10-11')).toMatchObject({ status: 'confirmed', activity: 'non_qualified', poe: 'false' })
    for (const a of allocs.filter(x => x.date === '2026-10-12')) expect([a.status, a.rev]).toEqual(['provisional', ''])
    const hours = table(fileOf(out, 'hours_by_component.csv'))
    const row = (week: string, component: string) => hours.find(h => h.week === week && h.component === component)
    expect(row('2026-W41', 'comp-alpha')).toEqual({ week: '2026-W41', component: 'comp-alpha', entity: 'acme', confirmedSeconds: '1980', liveSeconds: '1980', activity: 'direct_research', poe: 'true', status: 'confirmed', rev: '1', confirmedLagDays: '1' })
    expect(row('2026-W41', 'comp-beta')).toMatchObject({ confirmedSeconds: '6000', liveSeconds: '6640', status: 'changed' })
    expect(row('2026-W41', 'comp-gone')).toMatchObject({ confirmedSeconds: '500', liveSeconds: '0', status: 'changed' })
    expect(row('2026-W42', 'comp-beta')).toMatchObject({ confirmedSeconds: '', liveSeconds: '1733', status: 'provisional', rev: '' })
    // every table sums to its total in seconds
    expect(hours.reduce((s, h) => s + Number(h.liveSeconds), 0)).toBe(14000 + 3800)
    expect(table(fileOf(out, 'activity_notes.csv'))).toEqual([{ week: '2026-W41', component: 'comp-alpha', note: 'tried x, unsure about y' }])
  })
  test('blocks.csv and the monthly log', async () => {
    const out = build()
    const rows = table(fileOf(out, 'blocks.csv'))
    expect(rows.length).toBe(6)
    expect(rows[3]).toEqual({ date: '2026-10-11', start: '2026-10-11T22:24:00-04:00', end: '2026-10-12T00:00:00-04:00', seconds: '5600', eventCount: '4', method: METHOD, flags: 'over-4h' })
    expect(rows.reduce((s, r) => s + Number(r.seconds), 0)).toBe(17800)
    const log = fileOf(out, 'monthly_log.txt').split('\n')
    log.pop()
    expect(log.length % LOG_PAGE_LINES).toBe(0)
    expect(log[0]).toBe(`rd-ledger monthly log 2026-10 · method ${METHOD} · page 1 of 1`)
  })
  test('turns.csv: TTL change points, estimates through the pricing seam, formula cells neutralised', async () => {
    const rows = table(fileOf(build(), 'turns.csv'))
    expect(rows.map(r => [r.sessionId, r.seq, r.ttl, r.priced])).toEqual([
      [S1, '40', '5m', 'true'],
      [S1, '41', '1h', 'false'],
      [S2, '30', '5m', 'false'],
    ])
    expect(rows[0]).toMatchObject({ ts: '2026-10-11T09:01:40-04:00', input: '1000', output: '2000', cacheRead: '5000', cacheWrite: '400', estUsd: ((1000 * 4 + 2000 * 20 + 400 * 4 * 1.25) / 1e6).toFixed(6) })
    expect(rows[1]?.model).toBe(`'=HYPERLINK("x")`)
    expect(rows[2]).toMatchObject({ model: '', estUsd: '' })
  })
  test('spend_by_month.csv: the scope month only, tokens summed, labelled', async () => {
    const rows = table(fileOf(build(), 'spend_by_month.csv'))
    expect(rows).toEqual([
      { month: '2026-10', model: "'@SUM(A1)", component: '__unmapped__', entity: '', turns: '1', tokens: '1', estUsd: '', label: SPEND_LABEL },
      { month: '2026-10', model: 'claude-opus-5-5', component: 'comp-alpha', entity: 'acme', turns: '2', tokens: '100', estUsd: '0.5000', label: SPEND_LABEL },
    ])
    expect(table(fileOf(build({ scope: { year: '2026', month: null } }), 'spend_by_month.csv')).length).toBe(3)
  })
})

describe('copies, method and scope', () => {
  test('method.json carries the parameters, the price table and the rules', async () => {
    const m = JSON.parse(fileOf(build(), 'method.json')) as Record<string, unknown>
    expect(Object.keys(m)).toEqual(['version', 'generatedAt', 'scope', 'zone', 'method', 'params', 'admissionVersion', 'prices', 'pricesAsOf', 'cacheWriteMultiplier', 'defaultTtl', 'rounding', 'scopeRule', 'unreadable'])
    expect(m).toMatchObject({ version: '0.1.0', generatedAt: utcIso(D1 + 200_000_000), scope: '2026-10', zone: ZONE, method: METHOD, params: PARAMS, admissionVersion: 'admission-v1', pricesAsOf: PRICES_AS_OF, cacheWriteMultiplier: { '5m': 1.25, '1h': 2 }, defaultTtl: '5m', unreadable: 0 })
    expect(m.prices).toEqual(JSON.parse(JSON.stringify(PRICES)))
    expect(String(m.generatedAt)).toBe('2026-10-13T11:33:20.000Z')
  })
  test('sessions.ndjson: decoded, re-encoded, sorted, redacted; JSON copies scrub home paths and credentials', async () => {
    const out = build()
    const lines = fileOf(out, 'sessions.ndjson').split('\n')
    expect(lines.pop()).toBe('')
    const decoded = lines.map(l => decodeSession(l))
    expect(decoded.map(d => d?.sessionId)).toEqual([S1, S2, S3])
    expect(decoded[1]?.branch).toBe('[redacted:github-token]')
    expect(decoded[0]?.branch).toBe('feat/x 2026-10-11,forged,row =1')
    expect(out.redactions['sessions.ndjson']).toBe(1)
    // the unmapped segment carries its bucket, as its CSV rows do (PRV-4)
    expect(decoded[2]).toMatchObject({ repoKey: '__unmapped__', rootHash: null, cwdBase: '__unmapped__', branch: '__unmapped__' })
    for (const f of out.files) for (const banned of ['ghp_', 'gamma', 'personal/diary', HASH[S3] as string]) expect(f.text).not.toContain(banned)
    expect(fileOf(out, 'bridge.ndjson')).toContain('"--repo=~/rd-tracker"')
    expect(fileOf(out, 'bridge.ndjson')).not.toContain('/Users/')
    expect(out.redactions['bridge.ndjson']).toBe(1)
    expect(fileOf(out, 'components.json')).toBe(F1_MAPPING_JSON)
    expect(JSON.parse(fileOf(out, 'reviews.json'))).toEqual([W41])
    const leaky = build({ mappingText: JSON.stringify({ v: 1, entities: { acme: { name: 'owner@realmail.io', filing: 'c-corp' } }, __proto__x: 1 }) })
    expect(JSON.parse(fileOf(leaky, 'components.json'))).toEqual({ v: 1, entities: { acme: { name: '[redacted:email-address]', filing: 'c-corp' } }, __proto__x: 1 })
    expect(leaky.redactions['components.json']).toBe(1)
    expect(fileOf(build({ mappingText: 'not json /Users/someone/x' }), 'components.json')).toBe('"[redacted:home-path]"\n')
  })
  test('scope: a segment crossing the month boundary contributes only its rows inside the period', async () => {
    const crossing = segment(S4, 'beta', 'main', [
      { seq: 1, ts: Date.UTC(2026, 9, 1, 3, 30), origin: 'composer', admit: 1, reason: 'human', queued: 0 }, // 2026-09-30 23:30 local
      { seq: 2, ts: Date.UTC(2026, 9, 1, 4, 30), origin: 'composer', admit: 1, reason: 'human', queued: 0 }, // 2026-10-01 00:30 local
    ], [], Date.UTC(2026, 9, 1, 3, 0))
    const run = (month: string | null) => build({ scope: { year: '2026', month }, segments: [crossing], blocks: [], allocations: [], reviews: [] })
    expect(table(fileOf(run('2026-10'), 'events.csv')).map(r => r.date)).toEqual(['2026-10-01'])
    expect(table(fileOf(run('2026-09'), 'events.csv')).map(r => r.date)).toEqual(['2026-09-30'])
    expect(table(fileOf(run(null), 'events.csv')).length).toBe(2)
    expect(decodeSession(fileOf(run('2026-10'), 'sessions.ndjson').trim())?.events.map(ev => ev.seq)).toEqual([2])
    expect(fileOf(run('2026-08'), 'sessions.ndjson')).toBe('')
    expect(fileOf(run('2026-08'), 'monthly_log.txt')).toContain('No engagement recorded in 2026-08.')
    expect(() => build({ scope: { year: '2026', month: '2027-01' } })).toThrow()
    expect(() => build({ scope: { year: '26', month: null } })).toThrow()
  })
  test('manifest: sorted by name, two spaces, trailing newline', async () => {
    expect(manifestText([{ name: 'turns.csv', sha256: 'b'.repeat(64) }, { name: 'README.md', sha256: 'a'.repeat(64) }, { name: 'events.csv', sha256: 'c'.repeat(64) }])).toBe(`${'a'.repeat(64)}  README.md\n${'c'.repeat(64)}  events.csv\n${'b'.repeat(64)}  turns.csv\n`)
    expect(manifestText([])).toBe('')
  })
})

describe('data dictionary', () => {
  test('every SessionRecord, event and turn field, and every CSV and method.json column, has a meaning', async () => {
    const record: SessionRecord = {
      v: 1, sessionId: S1, seg: SEG, openedAt: 1, closedAt: null, closeReason: null, source: 'startup', entrypoint: null, interactive: true, surface: null, repoKey: null, repoKind: 'repo', rootHash: null, cwdBase: 'x', branch: null,
      branchChanges: [], model: null, cacheTtlChanges: [], nextSeq: 1, events: [], turns: [], eventsDropped: 0, turnsDropped: 0, malformedRows: 0, redactions: 0, engineCostAtOpen: null, engineCostUsd: null, extra: {}, updatedAt: 1,
    }
    const ev: EngagementEvent = { seq: 1, ts: 1, origin: 'composer', admit: 1, reason: 'human', queued: 0 }
    const tr: TurnRecord = { seq: 1, ts: 1, endTs: 2, turnId: 't', agentKey: '', agent: 0, model: null, in: 0, out: 0, cr: 0, cw: 0, reason: 'answer' }
    const has = (file: string, field: string) => DICTIONARY.some(d => d.file === file && d.field === field && d.meaning.length > 0)
    for (const k of Object.keys(record)) expect(has('sessions.ndjson', k)).toBe(true)
    for (const k of Object.keys(ev)) {
      expect(has('sessions.ndjson', `events[].${k}`)).toBe(true)
      expect(has('events.csv', k)).toBe(true)
    }
    for (const k of Object.keys(tr)) expect(has('sessions.ndjson', `turns[].${k}`)).toBe(true)
    const out = build()
    for (const [name, columns] of Object.entries(CSV_COLUMNS)) for (const c of columns) expect(has(name, c)).toBe(true)
    for (const k of Object.keys(JSON.parse(fileOf(out, 'method.json')) as object)) expect(has('method.json', k)).toBe(true)
    // one entry per (file, field)
    expect(new Set(DICTIONARY.map(d => `${d.file}|${d.field}`)).size).toBe(DICTIONARY.length)
  })
})

describe('default pricing', () => {
  test('buildExport prices turns through prices.ts', async () => {
    let implemented = true
    try {
      priceRow('claude-opus-5-5')
    } catch {
      implemented = false
    }
    // Until W1's prices.ts lands its functions throw; buildExport must then fail loudly, never fabricate a figure.
    if (!implemented) {
      expect(() => buildExport(input())).toThrow()
      return
    }
    const rows = table(fileOf(buildExport(input()), 'turns.csv'))
    const expected = priceTurn(turn(40, 32_500, 'claude-opus-5-5'), '5m')
    expect(rows[0]?.estUsd).toBe(expected.usd === null ? '' : expected.usd.toFixed(6))
  })
})

describe('components.json in the bundle (PRV-4)', () => {
  test('ignored and non-R&D repo entries are dropped and counted; component entries and their pre-tags stay', async () => {
    const text = JSON.stringify({ v: 1, gen: 3, entities: { acme: { name: 'Example Co', filing: 'c-corp' } }, components: { 'acme-app': { name: 'App', entity: 'acme', activity: 'direct_research', poe: false, rdt: null } }, repos: { shop: { component: 'acme-app' }, household: { nonRd: true, entity: 'acme' }, 'scratch#abcdef012345': { ignore: true } }, pretag: [{ repo: 'shop', branch: 'docs/*', activity: 'non_qualified', poe: false }, { repo: 'scratch', branch: null, activity: 'non_qualified', poe: false }] })
    const file = build({ mappingText: text }).files.find(f => f.name === 'components.json')
    const out = JSON.parse(file?.text ?? '{}') as Record<string, unknown>
    expect(Object.keys(out['repos'] as object)).toEqual(['shop'])
    expect((out['pretag'] as unknown[]).length).toBe(1)
    expect(out['_omitted']).toMatchObject({ ignored: 1, nonRd: 1 })
    expect(file?.text.includes('household')).toBe(false)
    expect(file?.text.includes('scratch')).toBe(false)
  })
})
