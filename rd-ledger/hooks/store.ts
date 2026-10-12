// rd-ledger: the store format (SPEC v1.1 §3). Pure: segment constructors,
// bounded updaters, encode/decode with shape validation (unknown keys kept in
// `extra`, rows never truncated on decode), the admission table, and the path
// builders. Every string that enters a record goes through cleanField here, so
// a caller cannot store a line break, a token or an email by mistake. No `$`.

import type { EngagementEvent, RecordSource, SessionRecord, TurnRecord, UnionParams } from '../types'
import { sha256 } from './hash'
import { cleanField, isSeg, isSessionId, oneLine, sha8 } from './text'

export const STORE_VERSION = 1 as const
/**
 * $.fs.read refuses a file over 4 MiB and the session itself must be able to
 * reload its segment. A turn is about 190 bytes as JSON and an event about 90,
 * so 8,000 of each keeps a segment near 2.3 MB; past a cap the counter grows
 * instead of the array (panel SEN-3). Decode never truncates (DBM-6).
 */
export const MAX_EVENTS = 8_000
export const MAX_TURNS = 8_000
export const MAX_BRANCH_CHANGES = 50
export const MAX_TTL_CHANGES = 50
/** rd-tracker's canonical union-v2 parameters (rdt/config.py 420-440). */
export const DEFAULT_PARAMS: UnionParams = { gapS: 1800, floorS: 60, maxBlockS: 14_400, dayFlagH: 14 }
/** The entrypoints rd-tracker admits as human (policy.py); the mod matches them. */
export const HUMAN_ENTRYPOINTS: ReadonlySet<string> = new Set(['claude-desktop', 'cli'])
/** The sentinel buckets an allocation can land in besides a component id. */
export const UNMAPPED = '__unmapped__'
export const IGNORED = '__ignored__'
export const NON_RD = '__non_rd__'

export const CAP = { entrypoint: 40, surface: 20, repoKey: 100, cwdBase: 100, branch: 200, model: 80, origin: 40, reason: 60, turnId: 80, reasonWord: 20, name: 80, note: 300, stdout: 200 } as const

const SOURCES: ReadonlySet<string> = new Set(['startup', 'resume', 'clear', 'fork', 'unknown'])
const REASONS: ReadonlySet<string> = new Set(['answer', 'aborted', 'refusal', 'error'])

const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)
const count = (n: unknown): number => Math.max(0, Math.floor(finite(n)))
const isRecordObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (x: unknown): string | null => (typeof x === 'string' ? x : null)

/** A cleaned field, with the redaction counted on the record. */
const take = (r: { redactions: number }, value: string | null | undefined, cap: number, isEngineId = false): string | null => {
  const out = cleanField(value, cap, { isEngineId })
  if (out.redacted) r.redactions += 1
  return out.value
}

/** The segment id for an open time: base-36 ms. */
export const segOf = (openedAt: number): string => Math.max(0, Math.floor(finite(openedAt))).toString(36)

export type NewSegmentInput = {
  sessionId: string
  openedAt: number
  source: RecordSource
  entrypoint: string | null
  interactive: boolean
  surface: string | null
  repoKey: string | null
  repoKind: 'repo' | 'dir'
  rootHash: string | null
  cwdBase: string
  branch: string | null
  model: string | null
  engineCostAtOpen: number | null
}

export const newSegment = (input: NewSegmentInput): SessionRecord => {
  const r: SessionRecord = {
    v: STORE_VERSION,
    sessionId: input.sessionId,
    seg: segOf(input.openedAt),
    openedAt: finite(input.openedAt),
    closedAt: null,
    closeReason: null,
    source: SOURCES.has(input.source) ? input.source : 'unknown',
    entrypoint: null,
    interactive: input.interactive === true,
    surface: null,
    repoKey: null,
    repoKind: input.repoKind === 'repo' ? 'repo' : 'dir',
    rootHash: input.rootHash && /^[0-9a-f]{12}$/.test(input.rootHash) ? input.rootHash : null,
    cwdBase: 'unknown',
    branch: null,
    branchChanges: [],
    model: null,
    cacheTtlChanges: [],
    nextSeq: 1,
    events: [],
    turns: [],
    eventsDropped: 0,
    turnsDropped: 0,
    malformedRows: 0,
    redactions: 0,
    // Startup starts the engine's ledger at zero; a resumed, cleared or forked process inherits a figure (DBM-12).
    engineCostAtOpen: input.source === 'startup' ? 0 : typeof input.engineCostAtOpen === 'number' && Number.isFinite(input.engineCostAtOpen) ? input.engineCostAtOpen : null,
    engineCostUsd: null,
    extra: {},
    updatedAt: finite(input.openedAt),
  }
  r.entrypoint = take(r, input.entrypoint, CAP.entrypoint)
  r.surface = take(r, input.surface, CAP.surface)
  r.repoKey = take(r, input.repoKey, CAP.repoKey)
  r.cwdBase = take(r, input.cwdBase, CAP.cwdBase) ?? 'unknown'
  r.branch = take(r, input.branch, CAP.branch)
  // The opening branch is the first change point, so the branch in force on any day is always recoverable (panel W1 note).
  if (r.branch !== null) r.branchChanges = [{ ts: r.openedAt, branch: r.branch }]
  r.model = take(r, input.model, CAP.model)
  return r
}

/** The admission verdict for a prompt submission (SPEC §4 table; CYB-1 adds the surface rule). */
export const admitEvent = (originKind: string, entrypoint: string | null, surface: string | null): { admit: 0 | 1; reason: string } => {
  const origin = oneLine(originKind, CAP.origin)
  const human = entrypoint !== null && HUMAN_ENTRYPOINTS.has(entrypoint)
  if (origin === 'composer' || origin === 'bridge') {
    if (human) return { admit: 1, reason: 'human' }
    return { admit: 0, reason: entrypoint === null ? 'entrypoint-unknown' : 'automation-entrypoint' }
  }
  if (origin === 'sdk') {
    if (entrypoint === 'claude-desktop') return surface === 'desktop' ? { admit: 1, reason: 'human-desktop-host' } : { admit: 0, reason: 'sdk-nested' }
    return { admit: 0, reason: entrypoint === null ? 'entrypoint-unknown' : 'automation-entrypoint' }
  }
  return { admit: 0, reason: `origin:${origin || 'unknown'}` }
}

/** A new segment with the event appended (bounded); the input is never mutated. */
export const withEvent = (r: SessionRecord, input: { ts: number; origin: string; queued: boolean }, now: number): SessionRecord => {
  if (r.events.length >= MAX_EVENTS) return { ...r, eventsDropped: r.eventsDropped + 1, updatedAt: now }
  const next = { ...r }
  // The origin is cleaned before the verdict, so a reason never carries a raw string (verifier V11).
  const origin = take(next, input.origin, CAP.origin) ?? 'unknown'
  const verdict = admitEvent(origin, r.entrypoint, r.surface)
  const event: EngagementEvent = { seq: r.nextSeq, ts: finite(input.ts), origin, admit: verdict.admit, reason: verdict.reason, queued: input.queued ? 1 : 0 }
  return { ...next, nextSeq: r.nextSeq + 1, events: [...r.events, event], updatedAt: now }
}

export type TurnInput = {
  endTs: number
  durationMs: number
  turnId: string
  agentId: string | null
  model: string | null
  usage: { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown } | null
  reason: string
}

/** `sha8(agentId)` or '' for the main loop. */
export const agentKeyOf = (agentId: string | null | undefined): string => (agentId ? sha8(agentId) : '')

/** A new segment with the turn appended (bounded); a `(turnId, agentKey)` already recorded is not recorded twice. */
export const withTurn = (r: SessionRecord, input: TurnInput, now: number): SessionRecord => {
  const idOut = cleanField(input.turnId, CAP.turnId, { isEngineId: true })
  const turnId = idOut.value ?? ''
  const agentKey = agentKeyOf(input.agentId)
  if (turnId !== '' && r.turns.some(t => t.turnId === turnId && t.agentKey === agentKey)) return r
  if (r.turns.length >= MAX_TURNS) return { ...r, turnsDropped: r.turnsDropped + 1, updatedAt: now }
  const next = { ...r, redactions: r.redactions }
  const endTs = finite(input.endTs)
  const turn: TurnRecord = {
    seq: r.nextSeq,
    ts: endTs - count(input.durationMs),
    endTs,
    turnId,
    agentKey,
    agent: agentKey === '' ? 0 : 1,
    model: take(next, input.model, CAP.model),
    in: count(input.usage?.input_tokens),
    out: count(input.usage?.output_tokens),
    cr: count(input.usage?.cache_read_input_tokens),
    cw: count(input.usage?.cache_creation_input_tokens),
    reason: (REASONS.has(input.reason) ? input.reason : 'error') as TurnRecord['reason'],
  }
  return { ...next, nextSeq: r.nextSeq + 1, turns: [...r.turns, turn], updatedAt: now }
}

export const withBranch = (r: SessionRecord, branch: string | null, now: number): SessionRecord => {
  const next = { ...r }
  const value = take(next, branch, CAP.branch)
  if (value === r.branch) return r
  const changes = r.branchChanges.length >= MAX_BRANCH_CHANGES ? r.branchChanges : [...r.branchChanges, { ts: finite(now), branch: value }]
  return { ...next, branch: value, branchChanges: changes, updatedAt: now }
}

/** The surface, learnt late: the desktop app attaches after session.start, so the record's surface is null until a draw or a command names it. */
export const withSurface = (r: SessionRecord, surface: string | null, now: number): SessionRecord => {
  const next = { ...r }
  const value = take(next, surface, CAP.surface)
  if (value === null || value === r.surface) return r
  return { ...next, surface: value, updatedAt: now }
}

export const withClose = (r: SessionRecord, reason: string, now: number): SessionRecord => {
  const next = { ...r }
  return { ...next, closedAt: finite(now), closeReason: take(next, reason, CAP.reasonWord), updatedAt: now }
}

/** The latest engine figure; a segment opened without one adopts the first figure it sees as its figure at open. */
export const withCost = (r: SessionRecord, usd: number | null, now: number): SessionRecord => {
  if (usd === null || !Number.isFinite(usd) || usd === r.engineCostUsd) return r
  return { ...r, engineCostUsd: usd, engineCostAtOpen: r.engineCostAtOpen ?? (r.engineCostUsd ?? usd), updatedAt: now }
}

/** A dated TTL change point; the same TTL again, an unknown value, or a full list changes nothing. */
export const withCacheTtl = (r: SessionRecord, ttl: unknown, now: number): SessionRecord => {
  const value = ttl === '1h' || ttl === '5m' ? ttl : null
  if (value === null) return r
  const last = r.cacheTtlChanges[r.cacheTtlChanges.length - 1]
  if (last && last.ttl === value) return r
  if (r.cacheTtlChanges.length >= MAX_TTL_CHANGES) return r
  return { ...r, cacheTtlChanges: [...r.cacheTtlChanges, { ts: finite(now), ttl: value }], updatedAt: now }
}

/** The segment's own engine cost: the latest figure less the figure at open; null when either is unknown. */
export const ownEngineCost = (r: SessionRecord): number | null =>
  r.engineCostUsd === null || r.engineCostAtOpen === null ? null : Math.max(0, r.engineCostUsd - r.engineCostAtOpen)

/** The cache TTL in force at `ts`: the last change point at or before it, else null (the option applies). */
export const ttlAt = (r: SessionRecord, ts: number): '5m' | '1h' | null => {
  let found: '5m' | '1h' | null = null
  for (const c of r.cacheTtlChanges) if (c.ts <= ts) found = c.ttl
  return found
}

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'v', 'sessionId', 'seg', 'openedAt', 'closedAt', 'closeReason', 'source', 'entrypoint', 'interactive', 'surface', 'repoKey', 'repoKind', 'rootHash', 'cwdBase', 'branch', 'branchChanges', 'model',
  'cacheTtlChanges', 'nextSeq', 'events', 'turns', 'eventsDropped', 'turnsDropped', 'malformedRows', 'redactions', 'engineCostAtOpen', 'engineCostUsd', 'extra', 'updatedAt',
])

/** The segment as JSON: the known keys in a fixed order, then `extra` spread back at the top level. */
/** A segment past this many bytes rolls over to a new one, so no file nears the 4 MiB read limit (verifier V6). */
export const SEGMENT_BYTES_MAX = 3 * 1024 * 1024
/** Checked every 250 rows (a row is at most a few hundred bytes): true when the encoded segment is past SEGMENT_BYTES_MAX. */
export const isOversize = (r: SessionRecord): boolean => {
  const rows = r.events.length + r.turns.length
  if (rows === 0 || rows % 250 !== 0) return false
  return new TextEncoder().encode(encodeSession(r)).length > SEGMENT_BYTES_MAX
}

export const encodeSession = (r: SessionRecord): string => {
  const { extra, ...known } = r
  const out: Record<string, unknown> = { ...known }
  for (const key of Object.keys(extra)) if (!KNOWN_KEYS.has(key)) out[key] = extra[key]
  return JSON.stringify(out)
}

const decodeEvent = (x: unknown, r: SessionRecord): EngagementEvent | null => {
  if (!isRecordObject(x)) return null
  const ts = x['ts']
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null
  return {
    seq: count(x['seq']),
    ts,
    origin: oneLine(str(x['origin']) ?? '', CAP.origin),
    admit: x['admit'] === 1 ? 1 : 0,
    reason: take(r, str(x['reason']) ?? 'unknown', CAP.reason) ?? 'unknown',
    queued: x['queued'] === 1 ? 1 : 0,
  }
}

const decodeTurn = (x: unknown, r: SessionRecord): TurnRecord | null => {
  if (!isRecordObject(x)) return null
  const ts = x['ts']
  const endTs = x['endTs']
  if (typeof ts !== 'number' || !Number.isFinite(ts) || typeof endTs !== 'number' || !Number.isFinite(endTs)) return null
  const reason = str(x['reason']) ?? ''
  const agentKey = str(x['agentKey']) ?? ''
  return {
    seq: count(x['seq']),
    ts,
    endTs,
    turnId: cleanField(str(x['turnId']) ?? '', CAP.turnId, { isEngineId: true }).value ?? '',
    agentKey: /^[0-9a-f]{8}$/.test(agentKey) ? agentKey : '',
    agent: x['agent'] === 1 ? 1 : 0,
    model: take(r, str(x['model']), CAP.model),
    in: count(x['in']),
    out: count(x['out']),
    cr: count(x['cr']),
    cw: count(x['cw']),
    reason: (REASONS.has(reason) ? reason : 'error') as TurnRecord['reason'],
  }
}

/**
 * A segment from its text, every field re-validated and re-cleaned (another
 * build, or a hand edit, may have written it); null for anything that is not
 * a v1 segment with a session id, a seg and an open time. Never throws. Rows
 * are never truncated (caps bound growth only); rows of the wrong shape are
 * counted in `malformedRows`; unknown top-level keys ride in `extra`. A newer
 * `v` is refused (null), so an older build never rewrites a newer file.
 */
export const decodeSession = (text: string): SessionRecord | null => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecordObject(raw) || raw['v'] !== STORE_VERSION) return null
  const sessionId = raw['sessionId']
  if (typeof sessionId !== 'string' || !isSessionId(sessionId)) return null
  const seg = raw['seg']
  if (typeof seg !== 'string' || !isSeg(seg)) return null
  const openedAt = raw['openedAt']
  if (typeof openedAt !== 'number' || !Number.isFinite(openedAt)) return null
  const r: SessionRecord = {
    v: STORE_VERSION,
    sessionId,
    seg,
    openedAt,
    closedAt: typeof raw['closedAt'] === 'number' && Number.isFinite(raw['closedAt']) ? raw['closedAt'] : null,
    closeReason: null,
    source: typeof raw['source'] === 'string' && SOURCES.has(raw['source']) ? (raw['source'] as RecordSource) : 'unknown',
    entrypoint: null,
    interactive: raw['interactive'] === true,
    surface: null,
    repoKey: null,
    repoKind: raw['repoKind'] === 'repo' ? 'repo' : 'dir',
    rootHash: typeof raw['rootHash'] === 'string' && /^[0-9a-f]{12}$/.test(raw['rootHash']) ? raw['rootHash'] : null,
    cwdBase: 'unknown',
    branch: null,
    branchChanges: [],
    model: null,
    cacheTtlChanges: [],
    nextSeq: Math.max(1, count(raw['nextSeq'])),
    events: [],
    turns: [],
    eventsDropped: count(raw['eventsDropped']),
    turnsDropped: count(raw['turnsDropped']),
    malformedRows: count(raw['malformedRows']),
    redactions: count(raw['redactions']),
    engineCostAtOpen: typeof raw['engineCostAtOpen'] === 'number' && Number.isFinite(raw['engineCostAtOpen']) ? raw['engineCostAtOpen'] : null,
    engineCostUsd: typeof raw['engineCostUsd'] === 'number' && Number.isFinite(raw['engineCostUsd']) ? raw['engineCostUsd'] : null,
    extra: {},
    updatedAt: typeof raw['updatedAt'] === 'number' && Number.isFinite(raw['updatedAt']) ? raw['updatedAt'] : openedAt,
  }
  // Redactions found while decoding are not re-counted on the record: the stored counter is the writer's.
  const scratch = { redactions: 0 }
  r.closeReason = take(scratch, str(raw['closeReason']), CAP.reasonWord)
  r.entrypoint = take(scratch, str(raw['entrypoint']), CAP.entrypoint)
  r.surface = take(scratch, str(raw['surface']), CAP.surface)
  r.repoKey = take(scratch, str(raw['repoKey']), CAP.repoKey)
  r.cwdBase = take(scratch, str(raw['cwdBase']), CAP.cwdBase) ?? 'unknown'
  r.branch = take(scratch, str(raw['branch']), CAP.branch)
  r.model = take(scratch, str(raw['model']), CAP.model)
  if (Array.isArray(raw['branchChanges'])) {
    for (const c of raw['branchChanges']) {
      if (!isRecordObject(c) || typeof c['ts'] !== 'number' || !Number.isFinite(c['ts'])) {
        r.malformedRows += 1
        continue
      }
      r.branchChanges.push({ ts: c['ts'], branch: take(scratch, str(c['branch']), CAP.branch) })
    }
  }
  if (Array.isArray(raw['cacheTtlChanges'])) {
    for (const c of raw['cacheTtlChanges']) {
      if (!isRecordObject(c) || typeof c['ts'] !== 'number' || !Number.isFinite(c['ts']) || (c['ttl'] !== '5m' && c['ttl'] !== '1h')) {
        r.malformedRows += 1
        continue
      }
      r.cacheTtlChanges.push({ ts: c['ts'], ttl: c['ttl'] })
    }
  }
  const scratchRecord = { redactions: 0 } as SessionRecord
  if (Array.isArray(raw['events'])) {
    for (const e of raw['events']) {
      const ev = decodeEvent(e, scratchRecord)
      if (ev) r.events.push(ev)
      else r.malformedRows += 1
    }
  }
  if (Array.isArray(raw['turns'])) {
    for (const t of raw['turns']) {
      const tr = decodeTurn(t, scratchRecord)
      if (tr) r.turns.push(tr)
      else r.malformedRows += 1
    }
  }
  for (const key of Object.keys(raw)) if (!KNOWN_KEYS.has(key)) r.extra[key] = raw[key]
  return r
}

// --- paths (HOME must be a plain absolute path; the caller checks) ----------------

export const storeDir = (home: string): string => `${home.replace(/\/+$/, '')}/.claude/rd-ledger`
export const timezonePath = (home: string): string => `${storeDir(home)}/timezone`
export const saltPath = (home: string): string => `${storeDir(home)}/salt`
export const mappingPath = (home: string): string => `${storeDir(home)}/components.json`
export const mappingHistoryPath = (home: string): string => `${storeDir(home)}/mapping-history.ndjson`
export const lockDir = (home: string): string => `${storeDir(home)}/.lock`
export const bridgeLogPath = (home: string, year: string): string => `${storeDir(home)}/bridge-${year.slice(0, 4)}.ndjson`
export const reviewsDir = (home: string): string => `${storeDir(home)}/reviews`
export const reviewPath = (home: string, week: string): string => `${reviewsDir(home)}/${week}.json`
export const sessionsDir = (home: string): string => `${storeDir(home)}/sessions`
/** `sessions/YYYY/MM` for a `YYYY-MM` month. */
export const monthDir = (home: string, yearMonth: string): string => `${sessionsDir(home)}/${yearMonth.slice(0, 4)}/${yearMonth.slice(5, 7)}`
export const segmentPath = (home: string, yearMonth: string, sessionId: string, seg: string): string => `${monthDir(home, yearMonth)}/${sessionId}.${seg}.json`
export const exportDir = (home: string, stamp: string): string => `${storeDir(home)}/export/${stamp}`
/** The temp file a flush goes to before `mv`: beside the final file, named for the segment and the flush count (SEN-4). */
export const tmpPath = (finalPath: string, seg: string, n: number): string => `${finalPath}.tmp.${seg.replace(/[^0-9a-z]/g, '')}.${Math.max(0, Math.floor(finite(n)))}`
export const isTmpName = (name: string): boolean => /\.json\.tmp\.[0-9a-z]*\.\d+$/.test(name)
/** `<uuid>.<seg>.json`, the only names the rollup reads. */
export const isSegmentName = (name: string): boolean => {
  const m = /^([0-9a-f-]{36})\.([0-9a-z]{1,16})\.json$/i.exec(name)
  return m !== null && isSessionId(m[1] as string)
}
/** `true` for a plain absolute path with no `..` segment and no line break: what HOME must be. */
export const isPlainAbsolute = (path: string | null | undefined): path is string =>
  typeof path === 'string' && path.startsWith('/') && !/(^|\/)\.\.(\/|$)/.test(path) && !/[\n\r\0]/.test(path) && path.length < 1024
/** The pinned input of the salted root hash (DBM-8, PRV-11): no newline, the root relative to HOME when inside it. */
export const rootHashOf = (salt: string, root: string, home: string): string => {
  const base = home.replace(/\/+$/, '')
  const rel = root === base ? '~' : root.startsWith(`${base}/`) ? `~/${root.slice(base.length + 1)}` : root
  return sha256(`${salt}|${rel}`).slice(0, 12)
}
/** A 32-hex salt from material only this install saw (no randomness API in the runtime). */
export const makeSalt = (material: string): string => sha256(`rd-ledger-salt|${material}`).slice(0, 32)
export const isSalt = (s: string): boolean => /^[0-9a-f]{32}$/.test(s)
