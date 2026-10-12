import { describe, expect, test } from 'claude-code/testing'

import type { BridgeInfo, BridgeLogEntry, HandoffEntry } from '../types'
import { IMPORT_PROGRAM, MAX_HUNDREDTHS, PROVENANCE, addArgv, argvForLog, bridgeLine, compareArgv, detectBridge, importArgv, parseAddLine, parseBridgeLog, parseCompareJson, parseImportJson, planHandoff } from './bridge'

// Synthetic paths only: the repo is never a real folder and no test touches the file system.
const REPO = '/fixture/rd-tracker'
const PY = `${REPO}/.venv/bin/python`
const INFO: Extract<BridgeInfo, { present: true }> = { present: true, repo: REPO, python: PY }
const SENTINEL = `SNTL-7f3a9c e@x.test ghp_${'a1B2c3D4e5'.repeat(4)}`

const fakeExists = (present: readonly string[]) => {
  const asked: string[] = []
  const exists = async (path: string): Promise<boolean> => {
    asked.push(path)
    return present.includes(path)
  }
  return { exists, asked }
}

const ALL = [`${REPO}/rdt/__init__.py`, `${REPO}/registries/components.yaml`, `${REPO}/.venv/bin/python`]

const entry = (over: Partial<HandoffEntry> = {}): HandoffEntry => ({
  week: '2026-W41',
  rev: 2,
  date: '2026-10-05',
  rdtEntity: 'acme',
  rdtComponent: 'acme-app',
  hundredths: 150,
  activity: 'direct_research',
  poe: false,
  note: null,
  startIso: null,
  endIso: null,
  ...over,
})

const logLine = (kind: BridgeLogEntry['kind'], row: HandoffEntry, over: Partial<BridgeLogEntry> = {}): BridgeLogEntry => ({
  at: 1_760_000_000_000,
  kind,
  week: row.week,
  rev: row.rev,
  date: row.date,
  rdtEntity: row.rdtEntity,
  rdtComponent: row.rdtComponent,
  hundredths: row.hundredths,
  argv: ['python', '-I', '-m', 'rdt', 'add'],
  exitCode: kind === 'intent' || kind === 'needs-manual-adjust' ? null : kind === 'failed' ? 2 : 0,
  rowId: kind === 'sent' ? 12 : null,
  label: kind === 'sent' ? 'contemporaneous' : null,
  lagDays: kind === 'sent' ? 0 : null,
  stdoutLine: '',
  ...over,
})

describe('detectBridge', () => {
  test('empty is not configured; a non-plain path is refused without probing', async () => {
    const f = fakeExists(ALL)
    expect(await detectBridge('', f.exists)).toEqual({ present: false, reason: 'not configured' })
    expect(await detectBridge('   ', f.exists)).toEqual({ present: false, reason: 'not configured' })
    for (const bad of ['fixture/rd-tracker', `${REPO}/../x`, `${REPO}\n/etc`, '/', `${REPO}\t`, '~/rd-tracker']) {
      const out = await detectBridge(bad, f.exists)
      expect(out.present).toBe(false)
    }
    expect(f.asked).toEqual([])
  })
  test('present only when all three files exist; python is the venv interpreter; the reason never names the path', async () => {
    expect(await detectBridge(REPO, fakeExists(ALL).exists)).toEqual({ present: true, repo: REPO, python: PY })
    expect(await detectBridge(`${REPO}/`, fakeExists(ALL).exists)).toEqual({ present: true, repo: REPO, python: PY })
    for (let i = 0; i < ALL.length; i++) {
      const out = await detectBridge(REPO, fakeExists(ALL.filter((_, j) => j !== i)).exists)
      expect(out.present).toBe(false)
      if (!out.present) expect(out.reason.includes(REPO)).toBe(false)
    }
    const throwing = async (): Promise<boolean> => {
      throw new Error('EACCES')
    }
    expect((await detectBridge(REPO, throwing)).present).toBe(false)
  })
})

describe('addArgv', () => {
  test('the exact argv, every flag one --flag=value token', async () => {
    expect(addArgv(INFO, entry())).toEqual([PY, '-I', '-m', 'rdt', 'add', '--date=2026-10-05', '--hours=1.50', '--entity=acme', '--component=acme-app', '--activity-type=direct_research', `--note=${PROVENANCE}: week 2026-W41 rev 2`])
    const full = addArgv(INFO, entry({ poe: true, note: 'tested two cache layouts', startIso: '2026-10-05T14:00:00.000Z', endIso: '2026-10-05T15:30:00.000Z', activity: 'direct_support', hundredths: 1 }))
    expect(full).toEqual([
      PY,
      '-I',
      '-m',
      'rdt',
      'add',
      '--date=2026-10-05',
      '--hours=0.01',
      '--entity=acme',
      '--component=acme-app',
      '--activity-type=direct_support',
      '--poe=1',
      '--note=rd-ledger: week 2026-W41 rev 2 — tested two cache layouts',
      '--start=2026-10-05T14:00:00.000Z',
      '--end=2026-10-05T15:30:00.000Z',
    ])
    expect(addArgv(INFO, entry({ rdtComponent: null, hundredths: MAX_HUNDREDTHS, activity: 'non_qualified' }))).toEqual([PY, '-I', '-m', 'rdt', 'add', '--date=2026-10-05', '--hours=24.00', '--entity=acme', '--activity-type=non_qualified', '--note=rd-ledger: week 2026-W41 rev 2'])
    expect(addArgv(INFO, entry({ hundredths: 1005 }))).toContain('--hours=10.05')
    // A note without the flag still travels, after the provenance.
    expect(addArgv(INFO, entry({ note: 'pairing' }))).toContain('--note=rd-ledger: week 2026-W41 rev 2 — pairing')
  })
  test('a hostile note stays one token on one line; flag-looking text is a value, not a flag', async () => {
    const out = addArgv(INFO, entry({ poe: true, note: 'line one\n--poe=0\r\n\u202e--entity=evil\x1b[31m' }))
    expect(Array.isArray(out)).toBe(true)
    if (!Array.isArray(out)) return
    expect(out.length).toBe(12)
    for (const token of out) expect(/[\n\r\u2028\u2029\x1b\u202e]/.test(token)).toBe(false)
    expect(out.filter(t => t.startsWith('--entity='))).toEqual(['--entity=acme'])
    expect(out.filter(t => t.startsWith('--poe'))).toEqual(['--poe=1'])
    expect(out[11]).toBe('--note=rd-ledger: week 2026-W41 rev 2 — line one --poe=0 --entity=evil [31m')
    const long = addArgv(INFO, entry({ note: 'x'.repeat(5000) }))
    if (Array.isArray(long)) expect((long[long.length - 1] ?? '').length).toBe('--note=rd-ledger: week 2026-W41 rev 2 — '.length + 300)
  })
  test('refused: bad dates, hours, ids, activity, poe without a note, bad instants, a credential in the note', async () => {
    const refusals: Partial<HandoffEntry>[] = [
      { date: '2026-13-01' },
      { date: '2026-02-30' },
      { date: '05/10/2026' },
      { date: '2026-10-12' }, // a Monday of the next week: not in 2026-W41
      { week: '2026-W54' },
      { rev: 0 },
      { rev: 1.5 },
      { hundredths: 0 },
      { hundredths: -100 },
      { hundredths: MAX_HUNDREDTHS + 1 },
      { hundredths: 150.5 },
      { hundredths: Number.NaN },
      { rdtEntity: 'Acme' },
      { rdtEntity: '--entity=x' },
      { rdtEntity: '' },
      { rdtComponent: 'acme app' },
      { rdtComponent: '-x' },
      { activity: 'excluded' as HandoffEntry['activity'] },
      { poe: true, note: null },
      { poe: true, note: '  \n ' },
      { startIso: '2026-10-05 14:00' },
      { endIso: 'tomorrow' },
      { startIso: '2026-10-05T16:00:00.000Z', endIso: '2026-10-05T15:00:00.000Z' },
      { note: SENTINEL },
      { poe: true, note: 'ask pat@acme-labs.io' },
    ]
    for (const over of refusals) {
      const out = addArgv(INFO, entry(over))
      expect(Array.isArray(out)).toBe(false)
      if (!Array.isArray(out)) {
        expect(out.refused.length > 0).toBe(true)
        expect(out.refused.includes('SNTL')).toBe(false)
      }
    }
    expect(Array.isArray(addArgv({ present: true, repo: 'rel', python: 'python3' }, entry()))).toBe(false)
  })
  test('ISO week edges decide whether a date is in the week', async () => {
    expect(Array.isArray(addArgv(INFO, entry({ date: '2027-01-01', week: '2026-W53' })))).toBe(true)
    expect(Array.isArray(addArgv(INFO, entry({ date: '2025-12-29', week: '2026-W01' })))).toBe(true)
    expect(Array.isArray(addArgv(INFO, entry({ date: '2027-01-04', week: '2027-W01' })))).toBe(true)
    expect(Array.isArray(addArgv(INFO, entry({ date: '2027-01-04', week: '2026-W53' })))).toBe(false)
    expect(Array.isArray(addArgv(INFO, entry({ date: '2028-02-29', week: '2028-W09' })))).toBe(true)
    expect(Array.isArray(addArgv(INFO, entry({ date: '2026-10-11', week: '2026-W41' })))).toBe(true)
  })
})

describe('compareArgv and importArgv', () => {
  test('review argv is exact and only for a real Monday', async () => {
    expect(compareArgv(INFO, '2026-10-05')).toEqual([PY, '-I', '-m', 'rdt', 'review', '--json', '--week=2026-10-05'])
    for (const bad of ['2026-10-06', '2026-02-30', 'monday', '2026-10-05 --answers=x', '']) expect(() => compareArgv(INFO, bad)).toThrow()
  })
  test('import argv is exact; the program is the safe_load literal and reads only its arguments', async () => {
    expect(importArgv(INFO)).toEqual([PY, '-I', '-c', IMPORT_PROGRAM, `${REPO}/registries/entities.yaml`, `${REPO}/registries/components.yaml`])
    expect(importArgv({ present: true, repo: `${REPO}/`, python: PY })).toEqual(importArgv(INFO))
    expect(IMPORT_PROGRAM.includes('safe_load')).toBe(true)
    for (const banned of ['yaml.load(', 'subprocess', 'os.', 'eval(', 'exec(', '__import__', 'pickle', 'socket', 'urllib']) expect(IMPORT_PROGRAM.includes(banned)).toBe(false)
    const opens = IMPORT_PROGRAM.match(/open\([^,)]*/g) ?? []
    expect(opens).toEqual(['open(sys.argv[1]', 'open(sys.argv[2]'])
  })
})

describe('argvForLog', () => {
  test('the interpreter reads python, the repo reads <repo>, the program reads <import-program>; the input is not changed', async () => {
    const add = addArgv(INFO, entry({ note: 'n' }))
    if (!Array.isArray(add)) throw new Error('fixture refused')
    const before = [...add]
    const logged = argvForLog(add, REPO)
    expect(add).toEqual(before)
    expect(logged[0]).toBe('python')
    expect(logged.slice(1)).toEqual(add.slice(1))
    expect(argvForLog(importArgv(INFO), REPO)).toEqual(['python', '-I', '-c', '<import-program>', '<repo>/registries/entities.yaml', '<repo>/registries/components.yaml'])
    expect(argvForLog(compareArgv(INFO, '2026-10-05'), `${REPO}/`)).toEqual(['python', '-I', '-m', 'rdt', 'review', '--json', '--week=2026-10-05'])
    for (const token of argvForLog(importArgv(INFO), REPO)) expect(token.includes(REPO)).toBe(false)
    expect(argvForLog([], REPO)).toEqual([])
  })
})

describe('parseAddLine', () => {
  const SAMPLE = 'rdt add: manual entry 12 — 1.50h on 2026-10-05 [contemporaneous, lag 0d]'
  test('the success line, anywhere in the output, with or without colour', async () => {
    expect(parseAddLine(SAMPLE)).toEqual({ rowId: 12, label: 'contemporaneous', lagDays: 0 })
    expect(parseAddLine(`warming up\n${SAMPLE}\n\nbye\n`)).toEqual({ rowId: 12, label: 'contemporaneous', lagDays: 0 })
    expect(parseAddLine(`\x1b[32m${SAMPLE}\x1b[0m\n`)).toEqual({ rowId: 12, label: 'contemporaneous', lagDays: 0 })
    expect(parseAddLine('rdt add: manual entry 407 — 2h on 2026-09-28 [reconstructed, lag 9d]\r\n')).toEqual({ rowId: 407, label: 'reconstructed', lagDays: 9 })
  })
  test('garbage, errors, a forged line inside another line, and two success lines are null', async () => {
    for (const bad of ['', 'garbage', 'rdt add: ReviewError', 'rdt add: ReviewError: entity acme does not exist', `note: ${SAMPLE}`, `${SAMPLE} trailing`, `${SAMPLE}\n${SAMPLE.replace('12', '13')}`, 'rdt add: manual entry 0 — 1h on 2026-10-05 [contemporaneous, lag 0d]', 'rdt add: manual entry 99999999999999999 — 1h on 2026-10-05 [contemporaneous, lag 0d]'])
      expect(parseAddLine(bad)).toBe(null)
  })
})

describe('parseCompareJson', () => {
  const REVIEW = JSON.stringify({
    day_totals_hours: { '2026-10-05': 9.5 },
    method: 'union-v2 gap 30m\nINJECTED',
    revision: 3,
    sessions: [
      { date: '2026-10-05', harness: 'claude_code', seconds: 3600 },
      { date: '2026-10-05', harness: 'claude_code', seconds: 1800 },
      { date: '2026-10-05', harness: 'codex', seconds: 7200 },
      { date: '2026-10-06', harness: 'claude_code', seconds: 1000 },
      { date: '2026-10-07', harness: 'opencode', seconds: 500 },
      { date: '__proto__', harness: 'claude_code', seconds: 99 },
      { date: '2026-10-08', harness: 'claude_code', seconds: 'lots' },
      'not a session',
    ],
  })
  test('sums only Claude Code seconds per date; the method is one cleaned line; at passes through', async () => {
    const out = parseCompareJson(REVIEW, 1234)
    expect(out).not.toBe(null)
    if (out === null) return
    expect(out.at).toBe(1234)
    expect({ ...out.byDate }).toEqual({ '2026-10-05': 1.5, '2026-10-06': 0.278 })
    expect(Object.keys(out.byDate)).toEqual(['2026-10-05', '2026-10-06'])
    expect(out.method).toBe('union-v2 gap 30m INJECTED')
  })
  test('missing sessions is an empty week, not garbage; garbage and non-objects are null', async () => {
    const empty = parseCompareJson(JSON.stringify({ method: 'm' }), 5)
    expect(empty === null ? null : { ...empty.byDate }).toEqual({})
    expect(empty?.method).toBe('m')
    expect(parseCompareJson('{"sessions": []}', 5)?.method).toBe(null)
    for (const bad of ['', 'garbage', '[]', '42', '"text"', 'null', '{"sessions": "many"}', 'x'.repeat(100 * 1024), JSON.stringify('y'.repeat(100 * 1024)), `{"sessions": []}${' '.repeat(5 * 1024 * 1024)}`])
      expect(parseCompareJson(bad, 5)).toBe(null)
  })
})

describe('parseImportJson', () => {
  test('ids by regex, names cleaned, filings checked, components without a valid entity dropped, prototype names inert', async () => {
    const text = '{"entities": {"acme": {"name": "Example Co\\nLLC", "filing": "c-corp"}, "Bad Id": {"name": "x"}, "__proto__": {"name": "polluted"}, "constructor": {"name": "Ctor Co", "filing": "llc"}, "beta": {}, "gamma": "nope"},' +
      ' "components": {"acme-app": {"name": "Example App", "entity": "acme"}, "orphan": {"name": "O", "entity": ""}, "evil": {"name": "E", "entity": "../x"}, "noname": {"entity": "beta"}, "secret": {"name": "' + `ghp_${'a1B2c3D4e5'.repeat(4)}` + '", "entity": "acme"}}}'
    const out = parseImportJson(text)
    expect(out).not.toBe(null)
    if (out === null) return
    expect(Object.getPrototypeOf(out.entities)).toBe(null)
    expect(Object.getPrototypeOf(out.components)).toBe(null)
    expect(Object.keys(out.entities)).toEqual(['acme', 'constructor', 'beta'])
    expect(out.entities['acme']).toEqual({ name: 'Example Co LLC', filing: 'c-corp' })
    expect(out.entities['constructor']).toEqual({ name: 'Ctor Co', filing: null })
    expect(out.entities['beta']).toEqual({ name: 'beta', filing: null })
    expect(Object.keys(out.components)).toEqual(['acme-app', 'noname', 'secret'])
    expect(out.components['noname']).toEqual({ name: 'noname', entity: 'beta' })
    expect(out.components['secret']).toEqual({ name: '[redacted:github-token]', entity: 'acme' })
    expect(({} as Record<string, unknown>)['polluted']).toBe(undefined)
  })
  test('garbage is null; an empty registry is empty', async () => {
    for (const bad of ['', 'nope', '[]', '{"entities": []}', '{"components": 3}']) expect(parseImportJson(bad)).toBe(null)
    const empty = parseImportJson('{}')
    expect(empty === null ? null : [Object.keys(empty.entities).length, Object.keys(empty.components).length]).toEqual([0, 0])
  })
})

describe('planHandoff', () => {
  const five = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map(date => entry({ date }))
  const [r1, r2, r3, r4, r5] = five as [HandoffEntry, HandoffEntry, HandoffEntry, HandoffEntry, HandoffEntry]

  test('SPEC §11.11: five adds with the third failing send two; the re-plan sends the remaining three; then nothing', async () => {
    expect(planHandoff(five, [])).toEqual({ send: five, adjust: [], blocked: [] })
    const firstPass = [logLine('intent', r1), logLine('sent', r1), logLine('intent', r2), logLine('sent', r2), logLine('intent', r3), logLine('failed', r3)]
    expect(firstPass.filter(l => l.kind === 'sent').length).toBe(2)
    expect(planHandoff(five, firstPass)).toEqual({ send: [r3, r4, r5], adjust: [], blocked: [] })
    const secondPass = [...firstPass, ...[r3, r4, r5].flatMap(r => [logLine('intent', r), logLine('sent', r)])]
    expect(planHandoff(five, secondPass)).toEqual({ send: [], adjust: [], blocked: [] })
  })
  test('an uncertain call or an intent with no outcome blocks the destination and nothing else; failed does not', async () => {
    const log = [logLine('intent', r1), logLine('uncertain', r1, { exitCode: 0 }), logLine('intent', r2), logLine('intent', r3), logLine('failed', r3), logLine('intent', r4), logLine('failed', r4), logLine('intent', r4), logLine('failed', r4)]
    expect(planHandoff(five, log)).toEqual({ send: [r3, r4, r5], adjust: [], blocked: [r1, r2] })
    // A crashed call followed by a retry that was sent still blocks: the crash may have made a row.
    expect(planHandoff([r1], [logLine('intent', r1), logLine('intent', r1), logLine('sent', r1)])).toEqual({ send: [], adjust: [], blocked: [r1] })
    // An uncertain line blocks even after a later sent line.
    expect(planHandoff([r1], [logLine('intent', r1), logLine('uncertain', r1), logLine('intent', r1), logLine('sent', r1)]).blocked).toEqual([r1])
  })
  test('same hundredths skipped; a different amount is an adjust, never a second add; a renamed component with the same rdt id is not re-sent', async () => {
    const sent = [logLine('intent', r1), logLine('sent', r1, { week: '2026-W41', rev: 1 })]
    expect(planHandoff([r1], sent)).toEqual({ send: [], adjust: [], blocked: [] })
    const changed = entry({ hundredths: 175 })
    expect(planHandoff([changed], sent)).toEqual({ send: [], adjust: [changed], blocked: [] })
    expect(planHandoff([changed], [...sent, logLine('needs-manual-adjust', changed)])).toEqual({ send: [], adjust: [changed], blocked: [] })
    const renamed = entry({ note: 'the component was renamed in the mod; the rdt id is unchanged' })
    expect(planHandoff([renamed], sent)).toEqual({ send: [], adjust: [], blocked: [] })
    // A sent line with no amount cannot be compared: blocked.
    expect(planHandoff([r1], [logLine('intent', r1), logLine('sent', r1, { hundredths: null })]).blocked).toEqual([r1])
  })
  test('zero hundredths: skipped when nothing was sent, an adjust when rd-tracker still holds hours', async () => {
    const zero = entry({ hundredths: 0 })
    expect(planHandoff([zero], [])).toEqual({ send: [], adjust: [], blocked: [] })
    expect(planHandoff([zero], [logLine('failed', zero)])).toEqual({ send: [], adjust: [], blocked: [] })
    expect(planHandoff([zero], [logLine('intent', r1), logLine('sent', r1)])).toEqual({ send: [], adjust: [zero], blocked: [] })
  })
  test('keys are (date, entity, component or empty); null components match; duplicates and refused rows block; output sorted', async () => {
    const bare = entry({ rdtComponent: null })
    const other = entry({ rdtEntity: 'beta', rdtComponent: null })
    const late = entry({ date: '2026-10-11' })
    const dupA = entry({ date: '2026-10-07', hundredths: 100 })
    const dupB = entry({ date: '2026-10-07', hundredths: 50 })
    const badPoe = entry({ date: '2026-10-08', poe: true, note: null })
    const rows = [late, other, dupB, bare, r1, badPoe, dupA]
    const plan = planHandoff(rows, [logLine('intent', r1), logLine('sent', r1, { hundredths: 150 })])
    expect(plan.send).toEqual([bare, other, late])
    expect(plan.adjust).toEqual([])
    expect(plan.blocked).toEqual([dupB, dupA, badPoe])
    // A sent line for the bare destination does not cover the component destination, and vice versa.
    expect(planHandoff([bare], [logLine('sent', r1)]).send).toEqual([bare])
    expect(planHandoff([r1], [logLine('sent', bare)]).send).toEqual([r1])
  })
  test('several sent lines compare by their sum, which is what rd-tracker holds', async () => {
    const log = [logLine('sent', r1, { hundredths: 100 }), logLine('sent', r1, { hundredths: 50 })]
    expect(planHandoff([r1], log)).toEqual({ send: [], adjust: [], blocked: [] })
    expect(planHandoff([entry({ hundredths: 100 })], log).adjust.length).toBe(1)
  })
})

describe('the bridge log', () => {
  test('null and empty read empty; malformed lines are counted and skipped; pending lists intents with no outcome', async () => {
    expect(parseBridgeLog(null)).toEqual({ entries: [], malformed: 0, pending: [] })
    expect(parseBridgeLog('')).toEqual({ entries: [], malformed: 0, pending: [] })
    const r1 = entry()
    const r2 = entry({ date: '2026-10-06' })
    const good = [logLine('intent', r1), logLine('sent', r1), logLine('intent', r2)]
    const bad = [
      '{"at": 1, "kind": "sent"',
      'not json',
      '[]',
      JSON.stringify({ ...JSON.parse(bridgeLine(good[0] as BridgeLogEntry)), kind: 'deleted' }),
      JSON.stringify({ ...JSON.parse(bridgeLine(good[0] as BridgeLogEntry)), at: 'yesterday' }),
      JSON.stringify({ ...JSON.parse(bridgeLine(good[0] as BridgeLogEntry)), argv: Array.from({ length: 41 }, () => 'x') }),
      JSON.stringify({ ...JSON.parse(bridgeLine(good[0] as BridgeLogEntry)), argv: ['x'.repeat(2001)] }),
      JSON.stringify({ ...JSON.parse(bridgeLine(good[0] as BridgeLogEntry)), argv: [1, 2] }),
      JSON.stringify({ ...JSON.parse(bridgeLine(good[0] as BridgeLogEntry)), rdtEntity: '../acme' }),
      JSON.stringify({ ...JSON.parse(bridgeLine(good[0] as BridgeLogEntry)), hundredths: -5 }),
      JSON.stringify({ ...JSON.parse(bridgeLine(good[0] as BridgeLogEntry)), date: '2026-10-05x' }),
    ]
    const text = [bridgeLine(good[0] as BridgeLogEntry), bad[0], bridgeLine(good[1] as BridgeLogEntry), ...bad.slice(1), '', '   ', bridgeLine(good[2] as BridgeLogEntry), ''].join('\n')
    const out = parseBridgeLog(text)
    expect(out.malformed).toBe(bad.length)
    expect(out.entries).toEqual(good)
    expect(out.pending).toEqual([good[2]])
  })
  test('a decoded line has exactly the declared keys; missing nullable fields read null; the stdout line is capped and one line', async () => {
    const minimal = JSON.stringify({ at: 7, kind: 'uncertain', rdtEntity: 'acme', argv: [], stdoutLine: `a\nb${'z'.repeat(500)}`, extra: 'dropped', __proto__x: 1 })
    const out = parseBridgeLog(minimal)
    expect(out.malformed).toBe(0)
    const e = out.entries[0]
    expect(e === undefined ? null : Object.keys(e)).toEqual(['at', 'kind', 'week', 'rev', 'date', 'rdtEntity', 'rdtComponent', 'hundredths', 'argv', 'exitCode', 'rowId', 'label', 'lagDays', 'stdoutLine'])
    expect(e?.week).toBe(null)
    expect(e?.stdoutLine.length).toBe(200)
    expect(e?.stdoutLine.startsWith('a b')).toBe(true)
  })
  test('bridgeLine: declared key order, no newline even for hostile text, and every line it writes reads back', async () => {
    const r = entry()
    const hostile = logLine('sent', r, { stdoutLine: `rdt add: manual entry 12\n{"at":0,"kind":"sent"}\u2028\r${SENTINEL}`, label: 'contemporaneous\nforged', argv: ['python', '--note=a\nb'] })
    const line = bridgeLine(hostile)
    expect(line.includes('\n')).toBe(false)
    expect(line.includes('\r')).toBe(false)
    expect(line.includes('\u2028')).toBe(false)
    // rdt's stdout is outside text: a credential in it is redacted whole before the log keeps it.
    expect(line.includes('ghp_')).toBe(false)
    expect(line.includes('SNTL')).toBe(false)
    expect(Object.keys(JSON.parse(line))).toEqual(['at', 'kind', 'week', 'rev', 'date', 'rdtEntity', 'rdtComponent', 'hundredths', 'argv', 'exitCode', 'rowId', 'label', 'lagDays', 'stdoutLine'])
    const back = parseBridgeLog(`${line}\n`)
    expect(back.malformed).toBe(0)
    expect(back.entries[0]?.label).toBe('contemporaneous forged')
    expect(back.entries[0]?.argv).toEqual(['python', '--note=a b'])
    // Round trip of an ordinary line is exact.
    const plain = logLine('intent', r)
    expect(parseBridgeLog(bridgeLine(plain)).entries).toEqual([plain])
    // Non-finite numbers never make an unreadable line (a lost intent would be re-sent).
    const odd = logLine('intent', r, { at: Number.NaN, rev: Number.POSITIVE_INFINITY, hundredths: 1.5, exitCode: Number.NaN, lagDays: 0.5 })
    const oddBack = parseBridgeLog(bridgeLine(odd))
    expect(oddBack.malformed).toBe(0)
    expect(oddBack.pending.length).toBe(1)
  })
})
