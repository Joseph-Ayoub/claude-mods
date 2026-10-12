import { describe, expect, test } from 'claude-code/testing'

import type { Mapping } from '../types'
import { applyQueueDecision, deadlines, emptyMapping, entityOf, historyLine, isNewLocation, loadMapping, mappingDigest, mergeImport, pretag, resolveRepo, saveMapping, seedMapping } from './mapping'

const m = (): Mapping => {
  const x = emptyMapping()
  x.entities['acme'] = { name: 'Example Co', filing: 'c-corp' }
  x.components['acme-app'] = { name: 'Example App', entity: 'acme', activity: 'direct_research', poe: true, rdt: 'acme-app' }
  x.repos['shop'] = { component: 'acme-app' }
  x.repos['shop#abcdef012345'] = { ignore: true }
  x.repos['house'] = { nonRd: true, entity: 'acme' }
  x.repos['ghost'] = { component: 'no-such' }
  x.repos['__proto__'] = { component: 'acme-app' }
  x.pretag.push({ repo: 'shop', branch: 'docs/*', activity: 'non_qualified', poe: false }, { repo: 'shop', branch: null, activity: 'direct_support', poe: false })
  return x
}

describe('mapping read side', () => {
  test('resolution: key#hash outranks the bare key; unknown targets resolve unmapped; prototype names are ordinary keys', async () => {
    const x = m()
    expect(resolveRepo(x, 'shop', null)).toEqual({ kind: 'component', component: 'acme-app', entity: 'acme', via: 'bare' })
    expect(resolveRepo(x, 'shop', 'abcdef012345')).toEqual({ kind: 'ignored', via: 'hash' })
    expect(resolveRepo(x, 'shop', 'ffffff000000')).toEqual({ kind: 'component', component: 'acme-app', entity: 'acme', via: 'bare' })
    expect(resolveRepo(x, 'house', null)).toEqual({ kind: 'nonRd', entity: 'acme', via: 'bare' })
    expect(resolveRepo(x, 'ghost', null)).toEqual({ kind: 'unmapped' })
    expect(resolveRepo(x, 'nope', null)).toEqual({ kind: 'unmapped' })
    expect(resolveRepo(x, '__proto__', null)).toEqual({ kind: 'component', component: 'acme-app', entity: 'acme', via: 'bare' })
    expect(resolveRepo(x, 'constructor', null)).toEqual({ kind: 'unmapped' })
    expect(resolveRepo(x, 'toString', null)).toEqual({ kind: 'unmapped' })
    expect(isNewLocation(x, 'shop', 'ffffff000000')).toBe(true)
    expect(isNewLocation(x, 'shop', 'abcdef012345')).toBe(false)
    expect(isNewLocation(x, 'nope', 'ffffff000000')).toBe(false)
    expect(isNewLocation(x, 'shop', null)).toBe(false)
    expect(entityOf(x, 'acme-app')).toBe('acme')
    expect(entityOf(x, 'constructor')).toBe(null)
  })
  test('pre-tag: first matching rule by glob over any branch seen that day, else the component defaults', async () => {
    const x = m()
    expect(pretag(x, 'acme-app', 'shop', ['main', 'docs/readme'])).toEqual({ activity: 'non_qualified', poe: false })
    expect(pretag(x, 'acme-app', 'shop', ['main'])).toEqual({ activity: 'direct_support', poe: false })
    expect(pretag(x, 'acme-app', 'other', ['docs/x'])).toEqual({ activity: 'direct_research', poe: true })
    expect(pretag(x, 'unknown', 'other', [])).toEqual({ activity: 'non_qualified', poe: false })
  })
  test('seed and digest', async () => {
    const s = seedMapping()
    expect(Object.keys(s.entities)).toEqual(['default'])
    expect(typeof s.extra['_help']).toBe('string')
    expect(Object.getPrototypeOf(s.repos)).toBe(null)
    expect(mappingDigest('{}')).toMatch(/^[0-9a-f]{64}$/)
  })
})

// --- W2: the write side -------------------------------------------------------------

/** A file in saveMapping's own shape: key order, two spaces, trailing newline. */
const canonicalFile = (): string =>
  `${JSON.stringify(
    {
      v: 1,
      gen: 7,
      entities: { acme: { name: 'Example Co', filing: 'c-corp' }, beta: { name: 'Beta', filing: null } },
      components: { 'acme-app': { name: 'Example App', entity: 'acme', activity: 'direct_research', poe: true, rdt: 'acme-app' }, 'beta-ops': { name: 'Ops', entity: 'beta', activity: 'direct_support', poe: false, rdt: null } },
      repos: { 'shop#3f9a1c2b7d4e': { component: 'acme-app' }, shop: { component: 'acme-app' }, scratch: { ignore: true }, house: { nonRd: true, entity: 'acme' }, ['__proto__']: { component: 'beta-ops' }, constructor: { ignore: true }, toString: { nonRd: true, entity: 'beta' } },
      pretag: [{ repo: 'shop', branch: 'docs/*', activity: 'non_qualified', poe: false }, { repo: 'shop', branch: null, activity: 'direct_support', poe: false }],
      _help: 'Top-level keys starting with _ are ignored.',
      _scratch: { anything: [1, 2, { ['__proto__']: { polluted: 1 } }] },
      future: { kept: true },
    },
    null,
    2,
  )}\n`

const has = (problems: string[], start: string): boolean => problems.some(p => p.startsWith(start))

describe('mapping write side: load', () => {
  test('null seeds; a canonical file round-trips byte for byte; tables are null-prototype; prototype names resolve', async () => {
    const seed = loadMapping(null)
    expect(seed.readOnly).toBe(false)
    expect(seed.problems).toEqual([])
    expect(Object.keys(seed.mapping.entities)).toEqual(['default'])
    const text = canonicalFile()
    const first = loadMapping(text)
    expect(first.readOnly).toBe(false)
    expect(first.problems).toEqual(['unknown top-level key future is kept as written and not used'])
    expect(saveMapping(first.mapping)).toBe(text)
    expect(saveMapping(loadMapping(saveMapping(first.mapping)).mapping)).toBe(text)
    const x = first.mapping
    for (const t of [x.entities, x.components, x.repos, x.extra]) expect(Object.getPrototypeOf(t)).toBe(null)
    expect(Object.keys(x.extra)).toEqual(['_help', '_scratch', 'future'])
    expect(resolveRepo(x, '__proto__', null)).toEqual({ kind: 'component', component: 'beta-ops', entity: 'beta', via: 'bare' })
    expect(resolveRepo(x, 'constructor', null)).toEqual({ kind: 'ignored', via: 'bare' })
    expect(resolveRepo(x, 'toString', null)).toEqual({ kind: 'nonRd', entity: 'beta', via: 'bare' })
    expect(resolveRepo(x, 'shop', '3f9a1c2b7d4e')).toEqual({ kind: 'component', component: 'acme-app', entity: 'acme', via: 'hash' })
    expect(x.gen).toBe(7)
    expect(({} as Record<string, unknown>)['polluted']).toBe(undefined)
  })

  test('invalid entries are dropped and named; names cleaned; enums closed; unknown targets kept but named', async () => {
    const text = JSON.stringify({
      v: 1,
      gen: -1,
      entities: { Bad_Id: { name: 'x', filing: null }, ok: { name: 'Ok\n  Co', filing: null }, tok: { name: 'ghp_abcdefghijklmnopqrstu', filing: 'c-corp' }, llc: { name: 'L', filing: 'llc' }, nofiling: { name: 'N' }, noname: { filing: null }, extra: { name: 'E', filing: null, note: 'hand' } },
      components: {
        'acme-app': { name: 'App', entity: 'ok', activity: 'direct_research', poe: true },
        'bad-act': { name: 'A', entity: 'ok', activity: 'research', poe: false },
        'bad-poe': { name: 'P', entity: 'ok', activity: 'direct_support', poe: 'yes' },
        'bad-rdt': { name: 'R', entity: 'ok', activity: 'direct_support', poe: false, rdt: 'Not An Id' },
        orphan: { name: 'O', entity: 'nobody', activity: 'direct_support', poe: false },
      },
      repos: {
        shop: { component: 'acme-app' },
        'shop#ABCDEF012345': { ignore: true },
        'shop#abcdef01234': { ignore: true },
        'a|b': { ignore: true },
        'x#y': { ignore: true },
        ghost: { component: 'no-such' },
        lost: { nonRd: true, entity: 'nobody' },
        two: { component: 'acme-app', ignore: true },
        falsy: { ignore: false },
        str: 'acme-app',
      },
      pretag: [
        { repo: 'shop', branch: 'docs/*', activity: 'non_qualified', poe: false },
        { repo: 'shop', branch: 'a*b', activity: 'non_qualified', poe: false },
        { repo: 'shop', branch: 'x'.repeat(101), activity: 'non_qualified', poe: false },
        { repo: 'shop', branch: null, activity: 'bogus', poe: false },
        { repo: 's#h', branch: null, activity: 'direct_support', poe: false },
        { repo: 'shop', branch: null, activity: 'direct_support', poe: 'no' },
        { repo: 'shop', activity: 'direct_support', poe: false },
        'nope',
      ],
    })
    const { mapping: x, problems, readOnly } = loadMapping(text)
    expect(readOnly).toBe(false)
    expect(x.gen).toBe(0)
    expect(has(problems, 'gen is not a whole number')).toBe(true)
    expect(Object.keys(x.entities)).toEqual(['ok', 'tok', 'nofiling', 'extra'])
    expect(x.entities['ok']).toEqual({ name: 'Ok Co', filing: null })
    expect(x.entities['tok']).toEqual({ name: '[redacted:github-token]', filing: 'c-corp' })
    expect(x.entities['nofiling']).toEqual({ name: 'N', filing: null })
    for (const p of ['entity Bad_Id dropped', 'entity llc dropped: filing', 'entity noname dropped: no name', 'entity tok: the name held a credential', 'entity extra: field note is not kept on save']) expect(has(problems, p)).toBe(true)
    expect(Object.keys(x.components)).toEqual(['acme-app', 'orphan'])
    expect(x.components['acme-app']).toEqual({ name: 'App', entity: 'ok', activity: 'direct_research', poe: true, rdt: null })
    for (const p of ['component bad-act dropped: activity', 'component bad-poe dropped: poe', 'component bad-rdt dropped: rdt', 'component orphan names entity nobody']) expect(has(problems, p)).toBe(true)
    expect(Object.keys(x.repos)).toEqual(['shop', 'ghost', 'lost'])
    for (const k of ['shop#ABCDEF012345', 'shop#abcdef01234', 'a|b', 'x#y', 'two', 'falsy', 'str']) expect(has(problems, `repos ${k} dropped`)).toBe(true)
    expect(has(problems, 'repos ghost names component no-such')).toBe(true)
    expect(has(problems, 'repos lost names entity nobody')).toBe(true)
    expect(resolveRepo(x, 'ghost', null)).toEqual({ kind: 'unmapped' })
    expect(x.pretag).toEqual([{ repo: 'shop', branch: 'docs/*', activity: 'non_qualified', poe: false }])
    for (let i = 2; i <= 8; i += 1) expect(has(problems, `pretag rule ${i} dropped`)).toBe(true)
    // Every problem line is one clean line: a hostile key cannot forge a second one.
    for (const p of problems) expect(p.includes('\n')).toBe(false)
  })

  test('a wrong version, unparseable text, or a broken table is read-only', async () => {
    for (const text of ['{"v":2,"entities":{}}', 'nope', '[]', '"v"', '{"gen":3}']) {
      const r = loadMapping(text)
      expect(r.readOnly).toBe(true)
      expect(Object.keys(r.mapping.entities)).toEqual(['default'])
      expect(r.problems.length).toBe(1)
    }
    expect(loadMapping('{"v":1,"entities":[]}')).toMatchObject({ readOnly: true, problems: ['entities is not an object; the file will not be rewritten'] })
    expect(loadMapping('{"v":1,"repos":"x"}').readOnly).toBe(true)
    expect(loadMapping('{"v":1,"pretag":{}}').readOnly).toBe(true)
    const bare = loadMapping('{"v":1}')
    expect(bare.readOnly).toBe(false)
    expect(bare.problems).toEqual([])
    expect(bare.mapping.gen).toBe(0)
    expect(Object.keys(bare.mapping.entities)).toEqual([])
  })
})

describe('mapping write side: save, decisions, import, deadlines, history', () => {
  test('save: fixed key order, extra after the tables, trailing newline, no prototype pollution', async () => {
    const x = seedMapping()
    x.gen = 3
    x.extra = Object.assign(Object.create(null) as Record<string, unknown>, { zeta: 1 })
    x.extra['__proto__'] = { polluted: true }
    x.extra['v'] = 99
    x.components['a'] = { name: 'A', entity: 'default', activity: 'direct_support', poe: false, rdt: null }
    const text = saveMapping(x)
    expect(text.startsWith('{\n  "v": 1,\n  "gen": 3,\n  "entities": {')).toBe(true)
    expect(text.endsWith('}\n')).toBe(true)
    const parsed = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['v', 'gen', 'entities', 'components', 'repos', 'pretag', 'zeta', '__proto__'])
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['polluted']).toBe(undefined)
    expect(parsed['v']).toBe(1)
    const back = loadMapping(text)
    expect(back.mapping.extra['__proto__']).toEqual({ polluted: true })
    expect(Object.getPrototypeOf(back.mapping.extra)).toBe(null)
  })

  test('queue decisions: written under the exact key, unknown targets refused, input never mutated', async () => {
    const base = loadMapping(canonicalFile()).mapping
    const before = saveMapping(base)
    const n = applyQueueDecision(base, 'shop#ffffff000000', { component: 'beta-ops' })
    expect(n).not.toBe(null)
    expect((n as Mapping).repos['shop#ffffff000000']).toEqual({ component: 'beta-ops' })
    expect(resolveRepo(n as Mapping, 'shop', 'ffffff000000')).toEqual({ kind: 'component', component: 'beta-ops', entity: 'beta', via: 'hash' })
    expect(isNewLocation(n as Mapping, 'shop', 'ffffff000000')).toBe(false)
    ;(n as Mapping).components['acme-app']!.name = 'changed'
    ;(n as Mapping).pretag.pop()
    expect(saveMapping(base)).toBe(before)
    expect(Object.getPrototypeOf((n as Mapping).repos)).toBe(null)
    expect(applyQueueDecision(base, 'shop', { component: 'no-such' })).toBe(null)
    expect(applyQueueDecision(base, 'shop', { component: 'constructor' })).toBe(null)
    expect(applyQueueDecision(base, 'shop', { nonRd: true, entity: 'nobody' })).toBe(null)
    expect(applyQueueDecision(base, 'a|b', { ignore: true })).toBe(null)
    expect(applyQueueDecision(base, 'shop#short', { ignore: true })).toBe(null)
    const replaced = applyQueueDecision(base, 'shop', { ignore: true }) as Mapping
    expect(replaced.repos['shop']).toEqual({ ignore: true })
    expect(Object.keys(replaced.repos)).toEqual(Object.keys(base.repos))
    expect((applyQueueDecision(base, 'misc', { nonRd: true, entity: 'beta' }) as Mapping).repos['misc']).toEqual({ nonRd: true, entity: 'beta' })
    expect((applyQueueDecision(base, '__proto__', { ignore: true }) as Mapping).repos['__proto__']).toEqual({ ignore: true })
    expect(saveMapping(base)).toBe(before)
  })

  test('import merge: only missing ids are added, never an overwrite, ids sorted', async () => {
    const base = loadMapping(canonicalFile()).mapping
    const before = saveMapping(base)
    const { mapping: x, added } = mergeImport(base, {
      entities: { acme: { name: 'Changed', filing: 's-corp' }, zeta: { name: 'Zeta\tLLC', filing: 'llc' as never }, gamma: { name: 'G', filing: 'partnership' }, 'Bad Id': { name: 'B', filing: null } },
      components: { 'acme-app': { name: 'Changed', entity: 'acme' }, 'zeta-tool': { name: 'Tool', entity: 'zeta' }, 'a-first': { name: '', entity: 'gamma' }, orphan: { name: 'O', entity: 'nobody' } },
    })
    expect(added).toEqual(['a-first', 'gamma', 'zeta', 'zeta-tool'])
    expect(x.entities['acme']).toEqual({ name: 'Example Co', filing: 'c-corp' })
    expect(x.entities['zeta']).toEqual({ name: 'Zeta LLC', filing: null })
    expect(x.entities['gamma']).toEqual({ name: 'G', filing: 'partnership' })
    expect(x.components['acme-app']).toEqual({ name: 'Example App', entity: 'acme', activity: 'direct_research', poe: true, rdt: 'acme-app' })
    expect(x.components['zeta-tool']).toEqual({ name: 'Tool', entity: 'zeta', activity: 'direct_research', poe: false, rdt: 'zeta-tool' })
    expect(x.components['a-first']).toEqual({ name: 'a-first', entity: 'gamma', activity: 'direct_research', poe: false, rdt: 'a-first' })
    expect(hasOwnKey(x.components, 'orphan')).toBe(false)
    expect(saveMapping(base)).toBe(before)
    expect(mergeImport(base, { entities: {}, components: {} }).added).toEqual([])
  })

  test('deadlines: per filing in the next year, the review Monday, sorted', async () => {
    const x = emptyMapping()
    x.entities['c'] = { name: 'C', filing: 'c-corp' }
    x.entities['s'] = { name: 'S', filing: 's-corp' }
    x.entities['sc'] = { name: 'SC', filing: 'schedule-c' }
    x.entities['p'] = { name: 'P', filing: 'partnership' }
    x.entities['o'] = { name: 'O', filing: 'other' }
    x.entities['n'] = { name: 'N', filing: null }
    const d = deadlines(x, 2026, '2026-10-13')
    expect(d.map(e => `${e.date} ${e.entity ?? '-'}`)).toEqual([
      '2026-10-19 -',
      '2027-03-15 p',
      '2027-03-15 s',
      '2027-04-15 c',
      '2027-04-15 sc',
      '2027-09-15 p',
      '2027-09-15 s',
      '2027-10-15 c',
      '2027-10-15 sc',
    ])
    expect(d[0]).toEqual({ date: '2026-10-19', label: 'Next weekly review (Monday)', entity: null })
    for (const e of d.slice(1)) expect(e.label.includes('calendar tax year; verify with your CPA')).toBe(true)
    expect(d.find(e => e.entity === 'c' && e.date === '2027-04-15')?.label.startsWith('Form 1120 due for tax year 2026')).toBe(true)
    expect(d.find(e => e.entity === 's' && e.date === '2027-09-15')?.label.startsWith('Form 1120-S extended')).toBe(true)
    expect(d.find(e => e.entity === 'p')?.label.startsWith('Form 1065')).toBe(true)
    expect(d.find(e => e.entity === 'sc')?.label.startsWith('Schedule C with Form 1040')).toBe(true)
    const review = (today: string): string | undefined => deadlines(emptyMapping(), 2026, today).find(e => e.entity === null)?.date
    expect(review('2026-10-12')).toBe('2026-10-12')
    expect(review('2026-10-11')).toBe('2026-10-12')
    expect(review('2026-10-17')).toBe('2026-10-19')
    expect(review('2026-12-29')).toBe('2027-01-04')
    expect(review('2028-02-28')).toBe('2028-02-28')
    expect(review('2028-02-29')).toBe('2028-03-06')
    expect(review('2026-02-31')).toBe(undefined)
    expect(review('soon')).toBe(undefined)
    expect(deadlines(x, Number.NaN, 'soon')).toEqual([])
  })

  test('history line: one JSON line, the change cleaned and scanned', async () => {
    const line = historyLine(1_760_000_000_000, 8, 'repos shop#abcdef012345 -> acme-app\nsecond')
    expect(line.includes('\n')).toBe(false)
    expect(JSON.parse(line)).toEqual({ at: 1_760_000_000_000, gen: 8, change: 'repos shop#abcdef012345 -> acme-app second' })
    expect(Object.keys(JSON.parse(line) as object)).toEqual(['at', 'gen', 'change'])
    expect(JSON.parse(historyLine(1, 2, 'token ghp_abcdefghijklmnopqrstu')).change).toBe('[redacted:github-token]')
    expect(JSON.parse(historyLine(1, 2, 'x'.repeat(500))).change.length).toBe(200)
    expect(JSON.parse(historyLine(Number.NaN, 1.5, ''))).toEqual({ at: 0, gen: 0, change: '' })
  })
})

const hasOwnKey = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
