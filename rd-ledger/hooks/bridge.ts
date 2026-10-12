// rd-ledger: the rd-tracker bridge (SPEC §7, ADR-003). Workstream W4. Pure:
// discovery decisions, argv builders, the hand-off plan, the log and the
// parsers. The register runs the argv and writes the log.
//
// The record this feeds is a tax record, so two failures matter more than any
// other: an argv that carries something it should not (argument injection, a
// credential in a note), and an hour counted twice. Every argv token is one
// `--flag=value` string built from values that passed a shape check here; and
// the plan never sends a destination whose last call has no known outcome.

import type { Activity, BridgeInfo, BridgeLogEntry, BridgeLogKind, CompareResult, Filing, HandoffEntry, HandoffPlan, ImportedRegistry } from '../types'
import { CAP, isPlainAbsolute } from './store'
import { cleanField, isDate, isId, isWeek, oneLine } from './text'

/** The fixed registry-import program: `python -I -c IMPORT_PROGRAM <entities.yaml> <components.yaml>`; it must contain `safe_load` and nothing that reads a path other than its two arguments. */
export const IMPORT_PROGRAM = [
  'import json, sys, yaml',
  'e = yaml.safe_load(open(sys.argv[1], encoding="utf-8")) or {}',
  'c = yaml.safe_load(open(sys.argv[2], encoding="utf-8")) or {}',
  'ents = {k: {"name": str((v or {}).get("legal_name") or k)} for k, v in (e.get("entities") or {}).items()}',
  'comps = {k: {"name": str((v or {}).get("name") or k), "entity": str((((v or {}).get("entity") or [{}])[-1] or {}).get("id") or "")} for k, v in (c.get("components") or {}).items()}',
  'print(json.dumps({"entities": ents, "components": comps}))',
].join('\n')

export const PROVENANCE = 'rd-ledger'

/** The most one destination can carry: 24 hours, rd-tracker's own `--hours` ceiling. */
export const MAX_HUNDREDTHS = 2400

const RDT_INIT = 'rdt/__init__.py'
const ENTITIES_YAML = 'registries/entities.yaml'
const COMPONENTS_YAML = 'registries/components.yaml'
const VENV_PYTHON = '.venv/bin/python'
/** The interpreter as the log spells it (CYB-10: the absolute path names the person's HOME). */
const LOG_INTERPRETER = 'python'
const LOG_REPO = '<repo>'
const LOG_PROGRAM = '<import-program>'
const LOG_MAX_TOKENS = 40
const LOG_MAX_TOKEN_CHARS = 2000
/** A longer log line is not one the mod wrote (40 tokens of 2000 plus the fixed fields). */
const LOG_MAX_LINE_CHARS = 128 * 1024
const LABEL_CAP = 40
/** `rdt review --json` for one busy week is tens of KB; anything past this is not its answer. */
const MAX_JSON_CHARS = 4 * 1024 * 1024
/** `rdt add` prints one line; a longer stdout is scanned only this far. */
const MAX_ADD_STDOUT_CHARS = 64 * 1024
const DAY_MS = 86_400_000

const ACTIVITIES: ReadonlySet<string> = new Set<Activity>(['direct_research', 'direct_support', 'non_qualified'])
const KINDS: ReadonlySet<string> = new Set<BridgeLogKind>(['intent', 'sent', 'uncertain', 'failed', 'needs-manual-adjust'])
const FILINGS: ReadonlySet<string> = new Set<Filing>(['c-corp', 's-corp', 'schedule-c', 'partnership', 'other'])

const isRecordObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

// --- calendar arithmetic (pure; no clock) ------------------------------------

/** Days since 1970-01-01 for a real calendar date from 1970 on; null for a shape-valid impossible date like 2026-02-31. */
const dayNumber = (date: string): number | null => {
  if (typeof date !== 'string' || !isDate(date)) return null
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const d = Number(date.slice(8, 10))
  if (y < 1970) return null
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const inMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0
  return d <= inMonth ? Date.UTC(y, m - 1, d) / DAY_MS : null
}

/** 0 for Monday through 6 for Sunday (1970-01-01 was a Thursday). */
const weekdayOf = (day: number): number => (((day + 3) % 7) + 7) % 7

/** The ISO week `YYYY-Www` holding a day: the week belongs to the year of its Thursday. */
const isoWeekOf = (day: number): string => {
  const thursday = day - weekdayOf(day) + 3
  let year = 1970 + Math.floor(thursday / 365.2425)
  while (Date.UTC(year, 0, 1) / DAY_MS > thursday) year -= 1
  while (Date.UTC(year + 1, 0, 1) / DAY_MS <= thursday) year += 1
  const week = Math.floor((thursday - Date.UTC(year, 0, 1) / DAY_MS) / 7) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** An instant as the register formats it (`toISOString`, or with an offset); the calendar must be real. */
const isIsoInstant = (s: unknown): s is string =>
  typeof s === 'string' &&
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.test(s) &&
  dayNumber(s.slice(0, 10)) !== null &&
  Number.isFinite(Date.parse(s))

/** Whole hundredths as `H.HH` by integer arithmetic, so no float rounding reaches rd-tracker. */
const hoursArg = (hundredths: number): string => `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`

const stripRepo = (path: string): string => String(path).replace(/\/+$/, '')

// --- discovery and argv ------------------------------------------------------

/** CONTRACT (W4). Whether the bridge is present: `rdtRepo` plain absolute and the three files exist (`exists` is injected). No PATH fallback. */
export const detectBridge = async (rdtRepo: string, exists: (path: string) => Promise<boolean>): Promise<BridgeInfo> => {
  if (typeof rdtRepo !== 'string' || rdtRepo.trim() === '') return { present: false, reason: 'not configured' }
  const repo = stripRepo(rdtRepo)
  // The reason is drawn in the pane, so it names the rule, never the path (the path names HOME).
  if (repo === '' || !isPlainAbsolute(repo) || /\p{Cc}/u.test(repo)) return { present: false, reason: 'the rd-tracker path is not a plain absolute path' }
  const probe = async (rel: string): Promise<boolean> => {
    try {
      return (await exists(`${repo}/${rel}`)) === true
    } catch {
      return false
    }
  }
  const wanted = [RDT_INIT, COMPONENTS_YAML, VENV_PYTHON]
  const found = await Promise.all(wanted.map(probe))
  const missing = wanted.filter((_, i) => !found[i])
  if (missing.length > 0) return { present: false, reason: `not found in the rd-tracker folder: ${missing.join(', ')}` }
  return { present: true, repo, python: `${repo}/${VENV_PYTHON}` }
}

/** The fixed provenance at the head of every note: where the hours came from, which week and which revision; no method or path. */
const provenanceOf = (week: string, rev: number): string => `${PROVENANCE}: week ${week} rev ${rev}`

/**
 * Why `rdt add` must not be called for this entry, or null when it may. Shared
 * by addArgv and planHandoff so the plan never offers to send what the argv
 * builder would refuse. The note is scanned whole: a credential or an email in
 * it refuses the entry rather than sending a redacted justification.
 */
const refusalOf = (entry: HandoffEntry): { reason: string } | { note: string | null } => {
  const day = dayNumber(entry.date)
  if (day === null) return { reason: 'the date is not a calendar date' }
  if (typeof entry.week !== 'string' || !isWeek(entry.week)) return { reason: 'the week is not an ISO week' }
  if (isoWeekOf(day) !== entry.week) return { reason: 'the date is not in the week' }
  if (!Number.isSafeInteger(entry.rev) || entry.rev < 1) return { reason: 'the revision is not a positive whole number' }
  if (!Number.isSafeInteger(entry.hundredths) || entry.hundredths <= 0 || entry.hundredths > MAX_HUNDREDTHS) return { reason: 'the hours must be above 0 and at most 24' }
  if (typeof entry.rdtEntity !== 'string' || !isId(entry.rdtEntity)) return { reason: 'the rd-tracker entity id is not valid' }
  if (entry.rdtComponent !== null && (typeof entry.rdtComponent !== 'string' || !isId(entry.rdtComponent))) return { reason: 'the rd-tracker component id is not valid' }
  if (!ACTIVITIES.has(entry.activity)) return { reason: 'the activity type is not one of the three' }
  const cleaned = cleanField(typeof entry.note === 'string' ? entry.note : null, CAP.note)
  if (cleaned.redacted) return { reason: 'the note holds a credential or an email address; edit the note first' }
  if (entry.poe === true && cleaned.value === null) return { reason: 'a process-of-experimentation flag needs a note' }
  if (entry.startIso !== null && !isIsoInstant(entry.startIso)) return { reason: 'the start is not an ISO instant' }
  if (entry.endIso !== null && !isIsoInstant(entry.endIso)) return { reason: 'the end is not an ISO instant' }
  if (entry.startIso !== null && entry.endIso !== null && Date.parse(entry.startIso) >= Date.parse(entry.endIso)) return { reason: 'the start is not before the end' }
  return { note: cleaned.value }
}

/** CONTRACT (W4). `[python, '-I', '-m', 'rdt', 'add', '--date=…', '--hours=H.HH', '--entity=…', '--component=…'?, '--activity-type=…', '--poe=1'?, '--note=…', '--start=…'?, '--end=…'?]`; refused on an invalid id, non-positive hours, or poe without a note. */
export const addArgv = (info: Extract<BridgeInfo, { present: true }>, entry: HandoffEntry): string[] | { refused: string } => {
  if (!isPlainAbsolute(info.python)) return { refused: 'the interpreter path is not plain' }
  const verdict = refusalOf(entry)
  if ('reason' in verdict) return { refused: verdict.reason }
  // Every value is one `--flag=value` token: argparse never reads a value as a flag.
  const argv = [info.python, '-I', '-m', 'rdt', 'add', `--date=${entry.date}`, `--hours=${hoursArg(entry.hundredths)}`, `--entity=${entry.rdtEntity}`]
  if (entry.rdtComponent !== null) argv.push(`--component=${entry.rdtComponent}`)
  argv.push(`--activity-type=${entry.activity}`)
  if (entry.poe === true) argv.push('--poe=1')
  argv.push(`--note=${provenanceOf(entry.week, entry.rev)}${verdict.note === null ? '' : ` — ${verdict.note}`}`)
  if (entry.startIso !== null) argv.push(`--start=${entry.startIso}`)
  if (entry.endIso !== null) argv.push(`--end=${entry.endIso}`)
  return argv
}

/**
 * CONTRACT (W4). `[python, '-I', '-m', 'rdt', 'review', '--json', '--week=<monday>']`.
 * The contract has no refusal shape, so a value that is not a real Monday throws:
 * the register's caller derives the Monday itself, and a wrong one is a bug to surface.
 */
export const compareArgv = (info: Extract<BridgeInfo, { present: true }>, monday: string): string[] => {
  if (!isPlainAbsolute(info.python)) throw new Error('compareArgv: the interpreter path is not plain')
  const day = dayNumber(monday)
  if (day === null || weekdayOf(day) !== 0) throw new Error('compareArgv: the week must be given by its Monday')
  return [info.python, '-I', '-m', 'rdt', 'review', '--json', `--week=${monday}`]
}

/** CONTRACT (W4). `[python, '-I', '-c', IMPORT_PROGRAM, '<repo>/registries/entities.yaml', '<repo>/registries/components.yaml']`. */
export const importArgv = (info: Extract<BridgeInfo, { present: true }>): string[] => {
  const repo = stripRepo(info.repo)
  if (!isPlainAbsolute(info.python) || repo === '' || !isPlainAbsolute(repo)) throw new Error('importArgv: the rd-tracker path is not plain')
  return [info.python, '-I', '-c', IMPORT_PROGRAM, `${repo}/${ENTITIES_YAML}`, `${repo}/${COMPONENTS_YAML}`]
}

/** CONTRACT (W4). The argv as the log stores it: the interpreter spelled `python`, `<repo>` for the repo path (CYB-10). */
export const argvForLog = (argv: readonly string[], repo: string): string[] => {
  const base = typeof repo === 'string' ? stripRepo(repo) : ''
  return argv.slice(0, LOG_MAX_TOKENS).map((token, i) => {
    if (i === 0) return LOG_INTERPRETER
    if (token === IMPORT_PROGRAM) return LOG_PROGRAM
    const text = String(token)
    return oneLine(base === '' ? text : text.split(base).join(LOG_REPO), LOG_MAX_TOKEN_CHARS)
  })
}

// --- parsers -------------------------------------------------------------------

/** CSI, OSC and two-character escape sequences, so a coloured line reads as its text. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** rd-tracker's success line, whole: anchored so a note echoed inside another line cannot pass for it. */
const ADD_LINE = /^rdt add: manual entry (\d{1,12}) (?:—|--?) (\d{1,2}(?:\.\d{1,4})?)h on (\d{4}-\d{2}-\d{2}) \[([a-z][a-z_-]{0,39}), lag (-?\d{1,5})d\]$/

/**
 * CONTRACT (W4). rd-tracker's `rdt add: manual entry <n> — <h>h on <date> [<label>, lag <d>d]` line → row id, label, lag; null when absent.
 * Null too when two lines match: one call makes one row, so a second line means
 * the output is not what it seems, and the caller logs the call `uncertain`.
 */
export const parseAddLine = (stdout: string): { rowId: number; label: string; lagDays: number } | null => {
  if (typeof stdout !== 'string') return null
  let found: { rowId: number; label: string; lagDays: number } | null = null
  let matches = 0
  for (const raw of stdout.slice(0, MAX_ADD_STDOUT_CHARS).split(/\r\n|\r|\n/)) {
    const m = ADD_LINE.exec(oneLine(raw.replace(ANSI, ''), 400))
    if (m === null) continue
    matches += 1
    const rowId = Number(m[1])
    const lagDays = Number(m[5]) + 0
    if (!Number.isSafeInteger(rowId) || rowId < 1 || !Number.isSafeInteger(lagDays)) return null
    found = { rowId, label: m[4] ?? '', lagDays }
  }
  return matches === 1 ? found : null
}

/** A JSON object from a bounded text; null for anything else. */
const parseObject = (text: unknown): Record<string, unknown> | null => {
  if (typeof text !== 'string' || text.length > MAX_JSON_CHARS) return null
  try {
    const value: unknown = JSON.parse(text.trim())
    return isRecordObject(value) ? value : null
  } catch {
    return null
  }
}

/** CONTRACT (W4). `rdt review --json` output → Claude Code hours per date (sum of `sessions[].seconds` where `harness` is `claude_code`) and the method; null for garbage. */
export const parseCompareJson = (text: string, at: number): CompareResult | null => {
  const root = parseObject(text)
  if (root === null) return null
  const sessions = root['sessions']
  if (sessions !== undefined && sessions !== null && !Array.isArray(sessions)) return null
  const seconds: Record<string, number> = Object.create(null) as Record<string, number>
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!isRecordObject(s) || s['harness'] !== 'claude_code') continue
    const date = s['date']
    const secs = s['seconds']
    if (typeof date !== 'string' || !isDate(date) || typeof secs !== 'number' || !Number.isFinite(secs) || secs < 0) continue
    seconds[date] = (seconds[date] ?? 0) + secs
  }
  // Seconds are summed first and converted once, so per-session rounding never accumulates.
  const byDate: Record<string, number> = Object.create(null) as Record<string, number>
  for (const date of Object.keys(seconds).sort()) byDate[date] = Math.round(((seconds[date] ?? 0) / 3600) * 1000) / 1000
  const method = typeof root['method'] === 'string' ? cleanField(root['method'], CAP.name).value : null
  return { at, byDate, method }
}

const nameOf = (value: unknown, id: string): string => (typeof value === 'string' ? cleanField(value, CAP.name).value : null) ?? id

/** CONTRACT (W4). The import program's JSON → a registry with ids passing `isId`, names cleaned, invalid entries dropped; null for garbage. */
export const parseImportJson = (text: string): ImportedRegistry | null => {
  const root = parseObject(text)
  if (root === null) return null
  const ents = root['entities'] ?? {}
  const comps = root['components'] ?? {}
  if (!isRecordObject(ents) || !isRecordObject(comps)) return null
  // Null-prototype tables: `constructor` is a valid id and must stay an ordinary key (CYB-8).
  const entities: ImportedRegistry['entities'] = Object.create(null) as ImportedRegistry['entities']
  const components: ImportedRegistry['components'] = Object.create(null) as ImportedRegistry['components']
  for (const id of Object.keys(ents)) {
    const v = ents[id]
    if (!isId(id) || !isRecordObject(v)) continue
    const filing = typeof v['filing'] === 'string' && FILINGS.has(v['filing']) ? (v['filing'] as Filing) : null
    entities[id] = { name: nameOf(v['name'], id), filing }
  }
  for (const id of Object.keys(comps)) {
    const v = comps[id]
    if (!isId(id) || !isRecordObject(v)) continue
    const entity = v['entity']
    if (typeof entity !== 'string' || !isId(entity)) continue
    components[id] = { name: nameOf(v['name'], id), entity }
  }
  return { entities, components }
}

// --- the hand-off plan and the log ---------------------------------------------

/** The destination key. Ids are `[a-z0-9-]` and dates digits and dashes, so `|` cannot occur inside a part. */
const destKey = (date: string | null, entity: string, component: string | null): string => `${date ?? ''}|${entity}|${component ?? ''}`

const OUTCOMES: ReadonlySet<string> = new Set<BridgeLogKind>(['sent', 'failed', 'uncertain'])

type DestState = { open: BridgeLogEntry[]; uncertain: boolean; sentAny: boolean; sentHundredths: number; sentUnknown: boolean }

/**
 * The log folded per destination, in file order (never by `at`: a clock step
 * must not reorder a call and its outcome). An outcome closes the most recent
 * open intent for its key, so `intent, intent, sent` leaves the first intent
 * open: a crashed call that may have made a row.
 */
const foldLog = (log: readonly BridgeLogEntry[]): Map<string, DestState> => {
  const states = new Map<string, DestState>()
  for (const e of log) {
    const key = destKey(e.date, e.rdtEntity, e.rdtComponent)
    let s = states.get(key)
    if (s === undefined) {
      s = { open: [], uncertain: false, sentAny: false, sentHundredths: 0, sentUnknown: false }
      states.set(key, s)
    }
    if (e.kind === 'intent') s.open.push(e)
    else if (OUTCOMES.has(e.kind)) s.open.pop()
    if (e.kind === 'uncertain') s.uncertain = true
    if (e.kind === 'sent') {
      s.sentAny = true
      if (typeof e.hundredths === 'number' && Number.isSafeInteger(e.hundredths) && e.hundredths > 0) s.sentHundredths += e.hundredths
      else s.sentUnknown = true
    }
    // `needs-manual-adjust` records a decision, not a call: it opens and closes nothing.
  }
  return states
}

const byDestination = (a: HandoffEntry, b: HandoffEntry): number => {
  const ka = [a.date, a.rdtEntity, a.rdtComponent ?? '']
  const kb = [b.date, b.rdtEntity, b.rdtComponent ?? '']
  for (let i = 0; i < 3; i++) {
    const x = ka[i] ?? ''
    const y = kb[i] ?? ''
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * CONTRACT (W4). The hand-off plan for a confirmed revision's rows against the
 * bridge log: key `(date, rdtEntity, rdtComponent ?? '')`; `send` when no
 * `sent` line matches at the same hundredths; `adjust` when a `sent` line has
 * a different amount; `blocked` when an `uncertain` (or an `intent` with no
 * outcome) exists for that key. Rows with 0 hundredths are skipped.
 *
 * Beyond the contract line, each rule errs toward not sending: several `sent`
 * lines compare by their sum (what rd-tracker holds); a `sent` line with no
 * amount blocks; two rows for one destination block both (one `rdt add` per
 * destination); a row the argv builder would refuse blocks; and a 0-hundredths
 * row is skipped only when nothing was sent, else it is an `adjust`, because
 * rd-tracker still holds hours the revision no longer claims.
 */
export const planHandoff = (rows: readonly HandoffEntry[], log: readonly BridgeLogEntry[]): HandoffPlan => {
  const states = foldLog(log)
  const groups = new Map<string, HandoffEntry[]>()
  for (const row of rows) {
    const key = destKey(row.date, row.rdtEntity, row.rdtComponent)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [row])
    else group.push(row)
  }
  const plan: HandoffPlan = { send: [], adjust: [], blocked: [] }
  for (const [key, group] of groups) {
    const row = group[0]
    if (row === undefined) continue
    if (group.length > 1) {
      plan.blocked.push(...group)
      continue
    }
    const s = states.get(key)
    if (s !== undefined && (s.uncertain || s.open.length > 0 || s.sentUnknown)) {
      plan.blocked.push(row)
      continue
    }
    if (row.hundredths === 0) {
      if (s !== undefined && s.sentAny) plan.adjust.push(row)
      continue
    }
    if (s !== undefined && s.sentAny) {
      if (s.sentHundredths !== row.hundredths) plan.adjust.push(row)
      continue
    }
    if ('reason' in refusalOf(row)) plan.blocked.push(row)
    else plan.send.push(row)
  }
  plan.send.sort(byDestination)
  plan.adjust.sort(byDestination)
  plan.blocked.sort(byDestination)
  return plan
}

const nullable = <T>(value: unknown, ok: (x: unknown) => x is T): T | null | undefined => (value === undefined || value === null ? null : ok(value) ? value : undefined)
const intIn = (min: number, max: number) => (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max
const strWhere = (test: (s: string) => boolean) => (x: unknown): x is string => typeof x === 'string' && test(x)
const ANY_INT = intIn(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
const REV = intIn(1, Number.MAX_SAFE_INTEGER)
const HUNDREDTHS = intIn(0, MAX_HUNDREDTHS)
const ROW_ID = intIn(1, Number.MAX_SAFE_INTEGER)
const WEEK = strWhere(isWeek)
const DATE = strWhere(isDate)
const ID = strWhere(isId)

/** One log line → an entry with exactly the declared keys, or null when any field is off-shape. A missing nullable field reads null. */
const decodeLogLine = (line: string): BridgeLogEntry | null => {
  if (line.length > LOG_MAX_LINE_CHARS) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecordObject(raw)) return null
  const at = raw['at']
  const kind = raw['kind']
  const argv = raw['argv']
  const stdoutLine = raw['stdoutLine']
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null
  if (!ID(raw['rdtEntity'])) return null
  if (!Array.isArray(argv) || argv.length > LOG_MAX_TOKENS || !argv.every(t => typeof t === 'string' && t.length <= LOG_MAX_TOKEN_CHARS)) return null
  if (typeof stdoutLine !== 'string') return null
  const week = nullable(raw['week'], WEEK)
  const rev = nullable(raw['rev'], REV)
  const date = nullable(raw['date'], DATE)
  const rdtComponent = nullable(raw['rdtComponent'], ID)
  const hundredths = nullable(raw['hundredths'], HUNDREDTHS)
  const exitCode = nullable(raw['exitCode'], ANY_INT)
  const rowId = nullable(raw['rowId'], ROW_ID)
  const label = nullable(raw['label'], (x: unknown): x is string => typeof x === 'string')
  const lagDays = nullable(raw['lagDays'], ANY_INT)
  if ([week, rev, date, rdtComponent, hundredths, exitCode, rowId, label, lagDays].includes(undefined)) return null
  return {
    at,
    kind: kind as BridgeLogKind,
    week: week ?? null,
    rev: rev ?? null,
    date: date ?? null,
    rdtEntity: raw['rdtEntity'] as string,
    rdtComponent: rdtComponent ?? null,
    hundredths: hundredths ?? null,
    argv: (argv as string[]).map(t => oneLine(t, LOG_MAX_TOKEN_CHARS)),
    exitCode: exitCode ?? null,
    rowId: rowId ?? null,
    label: typeof label === 'string' ? oneLine(label, LABEL_CAP) || null : null,
    lagDays: lagDays ?? null,
    stdoutLine: cleanField(stdoutLine, CAP.stdout).value ?? '',
  }
}

/** CONTRACT (W4). The log from its NDJSON text: malformed lines skipped and counted; an `intent` with no later outcome for its key is reported in `pending`. */
export const parseBridgeLog = (text: string | null): { entries: BridgeLogEntry[]; malformed: number; pending: BridgeLogEntry[] } => {
  const entries: BridgeLogEntry[] = []
  let malformed = 0
  if (typeof text !== 'string') return { entries, malformed, pending: [] }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const entry = decodeLogLine(line)
    if (entry === null) malformed += 1
    else entries.push(entry)
  }
  const pending: BridgeLogEntry[] = []
  for (const s of foldLog(entries).values()) pending.push(...s.open)
  pending.sort((a, b) => entries.indexOf(a) - entries.indexOf(b))
  return { entries, malformed, pending }
}

const writeInt = (x: unknown, ok: (v: unknown) => v is number): number | null => (ok(x) ? x : null)

/**
 * CONTRACT (W4). One log line as JSON (no newline). Keys in the declared order,
 * and every field shaped so parseBridgeLog reads the line back: a line the
 * reader dropped as malformed would lose an `intent`, and a lost intent is how
 * an hour gets sent twice.
 */
export const bridgeLine = (entry: BridgeLogEntry): string =>
  JSON.stringify({
    at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0,
    kind: entry.kind,
    week: entry.week,
    rev: writeInt(entry.rev, REV),
    date: entry.date,
    rdtEntity: entry.rdtEntity,
    rdtComponent: entry.rdtComponent,
    hundredths: writeInt(entry.hundredths, HUNDREDTHS),
    argv: (Array.isArray(entry.argv) ? entry.argv : []).slice(0, LOG_MAX_TOKENS).map(t => oneLine(String(t), LOG_MAX_TOKEN_CHARS)),
    exitCode: writeInt(entry.exitCode, ANY_INT),
    rowId: writeInt(entry.rowId, ROW_ID),
    label: typeof entry.label === 'string' ? oneLine(entry.label, LABEL_CAP) || null : null,
    lagDays: writeInt(entry.lagDays, ANY_INT),
    // rdt's stdout is outside text: scanned and redacted whole, like every stored field (text.ts).
    stdoutLine: cleanField(typeof entry.stdoutLine === 'string' ? entry.stdoutLine : '', CAP.stdout).value ?? '',
  })
