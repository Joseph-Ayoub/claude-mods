// rd-ledger: the export file set (SPEC §6.4). Workstream W3. Pure: builds the
// texts; the register writes them and verifies the manifest. Every cell goes
// through cleanField (redacted in place, counted) and csvCell.
//
// The export is the CPA's hardcopy of the store, so three rules hold for every
// file. (1) Redaction never aborts: a credential, an email address or a path
// under a home folder becomes `[redacted:<kind>]` or `~` in place and is
// counted by file and kind in the README. (2) Non-claimable rows (`__unmapped__`,
// `__ignored__`, `__non_rd__`, or a component pre-tagged or confirmed
// `non_qualified`) show the bucket name in place of the repo key, root hash and
// branch (PRV-4), so a personal repository never reaches the CPA by name. (3)
// Scope is by local date in the frozen zone: a row is in when its date falls in
// the period, so a segment crossing the boundary contributes only its rows
// inside it. Prices come through a `Pricing` seam (prices.ts by default) so the
// file shapes can be tested apart from the price table.

import type { Activity, Allocation, Block, BridgeLogEntry, Mapping, ReviewFile, ReviewRevision, SessionRecord, SpendRow, TurnRecord, UnionParams } from '../types'
import { pretag, resolveRepo } from './mapping'
import { CACHE_WRITE_MULTIPLIER, PRICES, PRICES_AS_OF, priceTurn, spendByMonth } from './prices'
import { BUCKETS, ESTIMATE_LABEL, isoWeekOfDate, localClock, monthlyLogPages, utcIso, weekDateList } from './report'
import { latestConfirmed, latestRevision, rowStatus } from './review'
import { CAP, IGNORED, NON_RD, UNMAPPED, decodeSession, encodeSession, ttlAt } from './store'
import { cleanField, csvLine, findCredentials, isDate, isMonth, isRedacted, isWeek, oneLine, scanJoined } from './text'

const ENGAGEMENT_MODEL_TEXT = `## 4. Engagement model — union-v2 parity

**Admission (stored per event):**

| Condition | admit | reason |
|---|---|---|
| origin \`composer\` or \`bridge\`, entrypoint ∈ {\`claude-desktop\`, \`cli\`} | 1 | \`human\` |
| origin \`sdk\`, entrypoint \`claude-desktop\`, record surface \`desktop\` | 1 | \`human-desktop-host\` |
| origin \`sdk\`, entrypoint \`claude-desktop\`, surface not \`desktop\` (a \`claude -p\` child of a desktop session inherits the variable) | 0 | \`sdk-nested\` |
| origin \`sdk\` otherwise | 0 | \`automation-entrypoint\` |
| entrypoint unset | 0 | \`entrypoint-unknown\` |
| any other origin kind (the \`PromptOrigin\` union, typed) | 0 | \`origin:<kind>\` |

Recorded after \`await next(e)\` only when the result has no \`drop\`. Slash commands typed by the
person: whether \`prompt.submit\` fires for them is a live-check item (§12); the README states
the parity gap either way (rd-tracker denies \`<command-name\` lines).

### 4.1 Determinism rules (rd-tracker parity, by line)

1. Instants are integer seconds: \`Math.floor(ts / 1000)\`.
2. Order admitted events by \`(instant, sessionId, seg, seq)\`; an event with the same
   \`(instant, sessionId)\` as the previous one is a duplicate and collapses (rd-tracker's
   dedupe key).
3. Merge while \`gap ≤ gapS\` (1800 merges, 1801 splits).
4. A chain whose span \`> maxBlockS\` splits at its largest gap; ties go to the gap nearest the
   chain's temporal midpoint, then the earlier gap (\`timeline.py:451-469\`); recurse.
5. Block seconds = last − first; a single-event block gets \`floorS\` (60) once, before the
   midnight split.
6. Midnight split: segments \`[lo, hi)\` half-open, the last closed on its end
   (\`timeline.py:522-527\`); seconds apportioned by event count with largest remainder, ties to
   the earlier segment (\`timeline.py:369-394\`).
7. Allocation: block seconds apportioned over its events with the same \`apportion\`; each
   event's seconds go to its session's \`repoKey#rootHash\` → component → entity, or to
   \`__unmapped__\` / \`__ignored__\` / the entity's \`non_qualified\` bucket for \`nonRd\`.
8. Flags, never auto-claimed: \`block-over-4h\` dated by the chain's first event
   (\`timeline.py:585\`); \`day-over-cap\` when a local day exceeds \`dayFlagH\`; \`automation-heavy\`
   when denied > 10 × admitted on a day (strictly greater); \`rows-dropped\` when any segment
   in scope has \`eventsDropped > 0\`.
9. Method string: \`union-v2/\` + first 8 hex of sha256 over
   \`{"automation_ratio":10,"day_flag_hours":14,"idle_gap_seconds":G,"max_block_seconds":14400,"single_event_floor_seconds":60,"timezone":"<zone>"}\`
   with sorted keys and no spaces (\`timeline.py:98-113\`). Golden: \`a5db146c\` for G = 1800 and
   \`America/New_York\`.
10. Integer seconds throughout; rounding once at display; every table's rows sum to its total
    in seconds.`

const RETENTION_TEXT = `### 3.6 Retention

The store **is** the record; the export is its hardcopy. Nothing is deleted except temp files
matching \`isTmpName\`, older than one hour, one \`rm -f <absolute path>\` each, never recursive.
Growth is bounded by the row caps (counters record drops). Back the store up off this Mac;
The R&D view's Pipeline section shows days since the last export and prompts after each closed month.
§1.6001-1(e) materiality and the 20-year §39 carryforward are the reasons.`

/** The header row of every CSV, in order (SPEC §6.4). */
export const CSV_COLUMNS = {
  'events.csv': ['date', 'ts', 'sessionId', 'seg', 'seq', 'repoKey', 'rootHash', 'branch', 'origin', 'admit', 'reason', 'queued'],
  'blocks.csv': ['date', 'start', 'end', 'seconds', 'eventCount', 'method', 'flags'],
  'allocations.csv': ['date', 'blockStart', 'sessionId', 'component', 'entity', 'seconds', 'activity', 'poe', 'status', 'rev'],
  'hours_by_component.csv': ['week', 'component', 'entity', 'confirmedSeconds', 'liveSeconds', 'activity', 'poe', 'status', 'rev', 'confirmedLagDays'],
  'activity_notes.csv': ['week', 'component', 'note'],
  'turns.csv': ['ts', 'endTs', 'sessionId', 'seg', 'seq', 'agent', 'model', 'input', 'output', 'cacheRead', 'cacheWrite', 'ttl', 'estUsd', 'priced'],
  'spend_by_month.csv': ['month', 'model', 'component', 'entity', 'turns', 'tokens', 'estUsd', 'label'],
} as const

/** The export's file names in the order they are built; MANIFEST.sha256 is the register's. */
export const EXPORT_FILES = ['README.md', 'method.json', 'events.csv', 'blocks.csv', 'allocations.csv', 'hours_by_component.csv', 'activity_notes.csv', 'turns.csv', 'spend_by_month.csv', 'monthly_log.txt', 'reviews.json', 'components.json', 'bridge.ndjson', 'sessions.ndjson'] as const

export const CAVEAT = "Nothing in this export is tax advice; what is claimed is the CPA's decision."
export const SPEND_LABEL = 'ESTIMATE list price, not an invoice'
const BUCKET_MEANING = 'or the bucket name (__unmapped__, __ignored__, __non_rd__) when the row is not claimable'
const ROUNDING_RULE = 'Integer seconds throughout; hours are seconds / 3600, rounded once at display to two decimals; every table sums to its total in seconds. Dollar estimates are unrounded sums, printed to six decimals per turn and four per month.'

/** CONTRACT (W3). Every field of the record types with its meaning; a test asserts every key of SessionRecord, EngagementEvent and TurnRecord appears. */
export const DICTIONARY: readonly { file: string; field: string; meaning: string }[] = [
  // sessions.ndjson: one session segment per line, as the store holds it (SPEC §3.1)
  ...([
    ['v', 'Store format version (1).'],
    ['sessionId', 'The Claude Code session id (a UUID).'],
    ['seg', 'Segment id: the open time in base-36 milliseconds; a new segment per process open and per local month. The row key of an event or turn is sessionId, seg and seq together.'],
    ['openedAt', 'When this process opened the segment, ms since the epoch (UTC).'],
    ['closedAt', 'When the segment was closed, ms since the epoch; null while open.'],
    ['closeReason', 'Why it closed (clear, logout, exit and similar); null while open.'],
    ['source', 'How the session started: startup, resume, clear, fork or unknown.'],
    ['entrypoint', 'The launcher word the engine reported (cli, claude-desktop, sdk-*); null when unset.'],
    ['interactive', 'True when the session had a person at a terminal or the desktop app.'],
    ['surface', 'The surface the session ran on (terminal, desktop, mobile and similar); null when unknown.'],
    ['repoKey', 'The basename of the repository or folder the session worked in (~ for the home folder, root for /).'],
    ['repoKind', 'repo when the folder is a git repository, dir otherwise.'],
    ['rootHash', 'First 12 hex of a salted sha256 of the root path, telling apart folders with the same basename; null when unknown.'],
    ['cwdBase', 'Basename of the working folder at open.'],
    ['branch', 'The git branch at the latest change; null when detached or not a repository.'],
    ['branchChanges', 'Each branch change: ts (ms) and branch.'],
    ['model', 'The model id at the latest change.'],
    ['cacheTtlChanges', 'Each prompt-cache TTL change: ts (ms) and ttl (5m or 1h); prices cache writes for later turns.'],
    ['nextSeq', 'The next row sequence number the writer would use.'],
    ['events', 'Prompt submissions with their admission verdicts (fields below).'],
    ['turns', 'Model turns with their token counts (fields below).'],
    ['eventsDropped', 'Events not stored because the row cap was reached.'],
    ['turnsDropped', 'Turns not stored because the row cap was reached.'],
    ['malformedRows', 'Rows a decode dropped because their shape was wrong.'],
    ['redactions', 'Fields the boundary scan redacted while this segment was written.'],
    ['engineCostAtOpen', "The engine's cumulative cost figure (USD) when the segment opened; null when unknown."],
    ['engineCostUsd', "The engine's latest cumulative cost figure (USD); this segment's own cost is the difference."],
    ['extra', 'Not a key in the file: top-level keys this build does not know, kept as written (credentials and home paths redacted).'],
    ['updatedAt', 'When the segment file was last written, ms since the epoch.'],
    ['branchChanges[].ts', 'When the branch changed, ms since the epoch.'],
    ['branchChanges[].branch', 'The branch from then on; null when detached.'],
    ['cacheTtlChanges[].ts', 'When the cache TTL changed, ms since the epoch.'],
    ['cacheTtlChanges[].ttl', 'The cache TTL from then on: 5m or 1h.'],
    ['events[].seq', 'Sequence number, unique within the segment.'],
    ['events[].ts', 'When the prompt was submitted (Enter), ms since the epoch.'],
    ['events[].origin', 'Where the prompt came from as the engine stamped it (composer, bridge, sdk, task-notification and others).'],
    ['events[].admit', '1 when counted as human engagement (SPEC §4 admission table), 0 when not.'],
    ['events[].reason', 'Why: human, human-desktop-host, sdk-nested, automation-entrypoint, entrypoint-unknown or origin:<kind>.'],
    ['events[].queued', '1 when typed while a turn was running (recorded at the moment it was queued).'],
    ['turns[].seq', 'Sequence number, unique within the segment.'],
    ['turns[].ts', 'When the turn started, ms since the epoch.'],
    ['turns[].endTs', 'When the turn finished, ms since the epoch.'],
    ['turns[].turnId', 'The engine turn id.'],
    ['turns[].agentKey', 'An 8-hex fingerprint of the subagent id; empty on the main loop.'],
    ['turns[].agent', '1 for a subagent turn, 0 for the main loop.'],
    ['turns[].model', 'The model id that answered; null when unknown.'],
    ['turns[].in', 'Input tokens.'],
    ['turns[].out', 'Output tokens.'],
    ['turns[].cr', 'Cache-read input tokens.'],
    ['turns[].cw', 'Cache-creation (cache write) input tokens.'],
    ['turns[].reason', 'How the turn ended: answer, aborted, refusal or error.'],
  ] as const).map(([field, meaning]) => ({ file: 'sessions.ndjson', field, meaning })),
  ...([
    ['date', 'Local calendar date of the event in the export zone.'],
    ['ts', 'When the prompt was submitted, ISO 8601 with the zone offset.'],
    ['sessionId', 'The session id.'],
    ['seg', 'The segment id.'],
    ['seq', 'Sequence number within the segment.'],
    ['repoKey', `The repository basename, ${BUCKET_MEANING}.`],
    ['rootHash', `The salted root hash, ${BUCKET_MEANING}.`],
    ['branch', `The git branch at that moment (empty when not recorded), ${BUCKET_MEANING}.`],
    ['origin', 'Where the prompt came from as the engine stamped it.'],
    ['admit', '1 when counted as human engagement, 0 when not.'],
    ['reason', 'The admission reason (SPEC §4).'],
    ['queued', '1 when typed while a turn was running.'],
  ] as const).map(([field, meaning]) => ({ file: 'events.csv', field, meaning })),
  ...([
    ['date', 'Local calendar date of the block (blocks never cross local midnight).'],
    ['start', 'First admitted event of the block, ISO 8601 with the zone offset.'],
    ['end', 'Last admitted event, or local midnight for a block split at midnight.'],
    ['seconds', 'Engagement seconds credited to the block (a single-event block gets the floor once).'],
    ['eventCount', 'Admitted events in the block.'],
    ['method', 'The method string the blocks were built with (union-v2/<hash of the parameters and zone>).'],
    ['flags', 'over-4h when the chain before the split exceeded the 4-hour cap; flags are never claimed automatically.'],
  ] as const).map(([field, meaning]) => ({ file: 'blocks.csv', field, meaning })),
  ...([
    ['date', 'Local calendar date.'],
    ['blockStart', 'Start of the block the seconds came from, ISO 8601 with the zone offset.'],
    ['sessionId', 'The session whose events earned the seconds.'],
    ['component', `The R&D component id, ${BUCKET_MEANING}.`],
    ['entity', 'The entity id the component belongs to.'],
    ['seconds', 'Seconds of the block apportioned to this session by event count.'],
    ['activity', 'direct_research, direct_support or non_qualified: the confirmed value, else the pre-tag.'],
    ['poe', 'true when the hours are marked process-of-experimentation, else false.'],
    ['status', 'confirmed (matches the latest confirmed review), provisional (the week has no confirmed review) or changed (differs from the confirmed review).'],
    ['rev', 'The confirmed review revision the status compares against; empty when none.'],
  ] as const).map(([field, meaning]) => ({ file: 'allocations.csv', field, meaning })),
  ...([
    ['week', 'ISO week (YYYY-Www) of the dates summed; only dates inside the export scope are summed.'],
    ['component', `The R&D component id, ${BUCKET_MEANING}.`],
    ['entity', 'The entity id.'],
    ['confirmedSeconds', 'Seconds frozen in the latest confirmed review for these rows; empty when the week is not confirmed.'],
    ['liveSeconds', 'Seconds as derived from the store today.'],
    ['activity', 'The activity of these rows (confirmed, else pre-tag).'],
    ['poe', 'true when marked process-of-experimentation.'],
    ['status', 'confirmed, provisional (no confirmed review for the week) or changed (live differs from frozen; frozen rows missing live are listed with liveSeconds 0).'],
    ['rev', 'The confirmed review revision; empty when none.'],
    ['confirmedLagDays', 'Days between the end of the week and its confirmation; empty when none.'],
  ] as const).map(([field, meaning]) => ({ file: 'hours_by_component.csv', field, meaning })),
  ...([
    ['week', 'ISO week of the note.'],
    ['component', 'The component the note is about.'],
    ['note', 'What was done, what was uncertain, what was tried, as the person typed it (at most 300 characters; credentials redacted).'],
  ] as const).map(([field, meaning]) => ({ file: 'activity_notes.csv', field, meaning })),
  ...([
    ['ts', 'When the turn started, ISO 8601 with the zone offset.'],
    ['endTs', 'When the turn finished, ISO 8601 with the zone offset.'],
    ['sessionId', 'The session id.'],
    ['seg', 'The segment id.'],
    ['seq', 'Sequence number within the segment.'],
    ['agent', '1 for a subagent turn, 0 for the main loop.'],
    ['model', 'The model id that answered.'],
    ['input', 'Input tokens (turns[].in).'],
    ['output', 'Output tokens (turns[].out).'],
    ['cacheRead', 'Cache-read input tokens (turns[].cr).'],
    ['cacheWrite', 'Cache-write input tokens (turns[].cw).'],
    ['ttl', 'The cache TTL assumed for the cache writes: the latest change point at or before the turn, else the cacheTtl option.'],
    ['estUsd', `The ${ESTIMATE_LABEL}, from the dated price table in method.json; empty when unpriced.`],
    ['priced', 'false when the model is not in the price table (tokens kept, no estimate).'],
  ] as const).map(([field, meaning]) => ({ file: 'turns.csv', field, meaning })),
  ...([
    ['month', 'Local month (YYYY-MM).'],
    ['model', 'The model id.'],
    ['component', `The R&D component id, ${BUCKET_MEANING}.`],
    ['entity', 'The entity id.'],
    ['turns', 'Turns counted.'],
    ['tokens', 'Input, output, cache-read and cache-write tokens summed.'],
    ['estUsd', `The ${ESTIMATE_LABEL}; empty when no turn of the row was priced.`],
    ['label', `Always "${SPEND_LABEL}": consumption at list prices, never invoiced spend.`],
  ] as const).map(([field, meaning]) => ({ file: 'spend_by_month.csv', field, meaning })),
  ...([
    ['version', 'The rd-ledger mod version that built the export.'],
    ['generatedAt', 'When the export was built, ISO 8601 UTC.'],
    ['scope', 'The period exported: YYYY or YYYY-MM.'],
    ['zone', 'The frozen time zone every local date and time uses.'],
    ['method', 'The method string (union-v2/<hash>).'],
    ['params', 'gapS (largest gap that merges), floorS (single-event floor), maxBlockS (block cap), dayFlagH (day flag hours).'],
    ['admissionVersion', 'The version of the admission table in force.'],
    ['prices', 'The price table: [model prefix, input, output, cache read] in USD per million tokens; longer prefixes first, first match wins.'],
    ['pricesAsOf', 'The date the price table was last checked.'],
    ['cacheWriteMultiplier', 'Cache writes cost input price times 1.25 under 5m and 2.0 under 1h.'],
    ['defaultTtl', 'The cacheTtl option: the TTL assumed where a session recorded none.'],
    ['rounding', 'The rounding rule.'],
    ['scopeRule', 'Which rows the export includes.'],
    ['unreadable', 'Store files that could not be read and are not in this export.'],
  ] as const).map(([field, meaning]) => ({ file: 'method.json', field, meaning })),
]

export type ExportInput = {
  scope: { year: string; month: string | null }
  segments: readonly SessionRecord[]
  blocks: readonly Block[]
  allocations: readonly Allocation[]
  reviews: readonly ReviewFile[]
  mapping: Mapping
  mappingText: string
  bridgeLog: readonly BridgeLogEntry[]
  zone: string
  params: UnionParams
  method: string
  defaultTtl: '5m' | '1h'
  version: string
  now: number
  personLabel: string
  /** sha256 of the mod's own union.ts and prices.ts texts, read by the register */
  sources: { unionSha256: string; pricesSha256: string }
  unreadable: number
  /** The admission table version string printed in method.json */
  admissionVersion: string
}

export type ExportFile = { name: string; text: string }

/** The two prices.ts functions the export uses; a seam so the file shapes are testable apart from the table. */
export type Pricing = {
  priceTurn: (t: TurnRecord, ttl: '5m' | '1h') => { usd: number | null; priced: boolean }
  spendByMonth: (segments: readonly SessionRecord[], mapping: Mapping, defaultTtl: '5m' | '1h', zone: string) => SpendRow[]
}

const PRICING: Pricing = { priceTurn, spendByMonth }

/** CONTRACT (W3). Every file of §6.4 except MANIFEST.sha256 (the register adds it from `sha256` over each text), plus the redaction counts. */
export const buildExport = (input: ExportInput): { files: ExportFile[]; redactions: Record<string, number> } => buildExportWith(input, PRICING)

/** A path under a home folder, at the start of a value or after a separator; it reads `~` in the export. */
const hasHomePath = (s: string): boolean => /(?:^|[\s"'=:,(])\/(?:Users|home)\/[^/\s"',;]+/.test(s)
const scrubHomePaths = (s: string): string => s.replace(/(^|[\s"'=:,(])\/(?:Users|home)\/[^/\s"',;]+/g, '$1~')
const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0)
const finiteCount = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)
const kindOf = (redacted: string): string => redacted.slice('[redacted:'.length, -1)

/** `buildExport` with an explicit pricing seam (the tests pass a synthetic one). */
export const buildExportWith = (input: ExportInput, pricing: Pricing): { files: ExportFile[]; redactions: Record<string, number> } => {
  const { scope, mapping } = input
  if (!/^\d{4}$/.test(scope.year) || (scope.month !== null && !(isMonth(scope.month) && scope.month.startsWith(`${scope.year}-`))))
    throw new Error('buildExport: the scope is YYYY, or YYYY-MM inside that year')
  const scopeLabel = scope.month ?? scope.year
  const prefix = `${scopeLabel}-`
  const inScope = (date: string): boolean => date.startsWith(prefix)
  const clock = localClock(input.zone)
  const tsInScope = (ts: number): boolean => Number.isFinite(ts) && inScope(clock.date(ts))

  // --- redaction, counted by file and kind -------------------------------------------
  const tally = new Map<string, Map<string, number>>()
  const count = (fileName: string, kind: string): void => {
    const byKind = tally.get(fileName) ?? new Map<string, number>()
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1)
    tally.set(fileName, byKind)
  }
  /** One value as it may leave the Mac: scanned (whole value redacted on a hit), one line, home paths read `~`. */
  const clean = (fileName: string, value: string | number | boolean | null | undefined, cap = 200): string => {
    if (value === null || value === undefined) return ''
    const out = cleanField(String(value), cap)
    if (out.value === null) return ''
    if (out.redacted) {
      count(fileName, kindOf(out.value))
      return out.value
    }
    if (!hasHomePath(out.value)) return out.value
    count(fileName, 'home-path')
    return scrubHomePaths(out.value)
  }
  /** The same rule over every string (and key) of a JSON value; never truncates and keeps line breaks out. */
  const deep = (fileName: string, value: unknown): unknown => {
    if (typeof value === 'string') {
      // Scan the joined form: an invisible character inside a token must not hide it (verifier V2).
      const reason = scanJoined(value)
      if (reason !== null) {
        count(fileName, reason)
        return `[redacted:${reason}]`
      }
      if (!hasHomePath(value)) return value
      count(fileName, 'home-path')
      return scrubHomePaths(value)
    }
    if (Array.isArray(value)) return value.map(v => deep(fileName, v))
    if (value !== null && typeof value === 'object') {
      // fromEntries defines own properties, so a `__proto__` key stays an ordinary key.
      return Object.fromEntries(Object.keys(value).map((k, i) => {
        const key = deep(fileName, k) as string
        return [isRedacted(key) ? `${key}#${i}` : key, deep(fileName, (value as Record<string, unknown>)[k])]
      }))
    }
    return value
  }
  const csv = (fileName: keyof typeof CSV_COLUMNS, rows: readonly (readonly (string | number | boolean | null | undefined)[])[], caps: Partial<Record<string, number>> = {}): ExportFile => {
    const header = CSV_COLUMNS[fileName]
    const lines = [csvLine(header)]
    for (const row of rows) lines.push(csvLine(row.map((v, i) => clean(fileName, v, caps[header[i] as string] ?? 200))))
    return { name: fileName, text: `${lines.join('\n')}\n` }
  }

  // --- lookups ----------------------------------------------------------------------------
  const segKey = (sessionId: string, seg: string): string => `${sessionId}|${seg}`
  const segments = new Map<string, SessionRecord>()
  for (const s of input.segments) segments.set(segKey(s.sessionId, s.seg), s)
  const reviewsByWeek = new Map<string, ReviewFile>()
  for (const r of input.reviews) if (isWeek(r.week)) reviewsByWeek.set(r.week, r)
  const confirmedOf = (week: string): ReviewRevision | null => {
    const r = reviewsByWeek.get(week)
    return r ? latestConfirmed(r) : null
  }
  const liveByKey = new Map<string, number>()
  for (const a of input.allocations) liveByKey.set(`${a.component}|${a.date}`, (liveByKey.get(`${a.component}|${a.date}`) ?? 0) + finiteCount(a.seconds))
  const allocsBySeg = new Map<string, Allocation[]>()
  for (const a of input.allocations) {
    const list = allocsBySeg.get(segKey(a.sessionId, a.seg)) ?? []
    list.push(a)
    allocsBySeg.set(segKey(a.sessionId, a.seg), list)
  }

  /**
   * The branch at `ts`: the last change at or before it; the segment's branch
   * when it never changed; empty (null) before the first change, because the
   * store records the branch at open only until the first change replaces it.
   */
  const branchAt = (s: SessionRecord, ts: number): string | null => {
    if (s.branchChanges.length === 0) return s.branch
    let found: string | null | undefined
    for (const c of s.branchChanges) if (c.ts <= ts) found = c.branch
    return found === undefined ? null : found
  }
  /** Branches seen on `date` by the segment's admitted events (the pre-tag's input), one pass per segment. */
  const branchMemo = new Map<string, Map<string, Set<string>>>()
  const branchesOn = (s: SessionRecord, date: string): string[] => {
    const key = segKey(s.sessionId, s.seg)
    let byDate = branchMemo.get(key)
    if (!byDate) {
      byDate = new Map<string, Set<string>>()
      for (const ev of s.events) {
        if (ev.admit !== 1) continue
        const b = branchAt(s, ev.ts)
        if (b === null) continue
        const d = clock.date(ev.ts)
        byDate.set(d, (byDate.get(d) ?? new Set<string>()).add(b))
      }
      branchMemo.set(key, byDate)
    }
    const seen = byDate.get(date)
    return seen ? [...seen] : s.branch === null ? [] : [s.branch]
  }
  /** Activity and POE of an allocation row: the confirmed review's, else the pre-tag (buckets are never claimable). */
  const tagOf = (a: Allocation): { activity: Activity; poe: boolean } => {
    const confirmed = confirmedOf(isoWeekOfDate(a.date))
    const key = `${a.component}|${a.date}`
    if (confirmed && Object.prototype.hasOwnProperty.call(confirmed.rows, key)) {
      const frozen = confirmed.rows[key] as ReviewRevision['rows'][string]
      return { activity: frozen.activity, poe: frozen.poe }
    }
    if (BUCKETS.has(a.component)) return { activity: 'non_qualified', poe: false }
    const s = segments.get(segKey(a.sessionId, a.seg))
    return pretag(mapping, a.component, s?.repoKey ?? '', s ? branchesOn(s, a.date) : [])
  }
  const claimable = (a: Allocation): boolean => !BUCKETS.has(a.component) && tagOf(a).activity !== 'non_qualified'
  /** null when the segment's rows may name its repository; otherwise the bucket they show instead (PRV-4). */
  const bucketOf = (s: SessionRecord): string | null => {
    const allocs = allocsBySeg.get(segKey(s.sessionId, s.seg)) ?? []
    if (allocs.length > 0) {
      if (allocs.some(claimable)) return null
      return allocs.find(a => BUCKETS.has(a.component))?.component ?? NON_RD
    }
    // No admitted seconds: resolve the repository the way allocation would.
    if (s.repoKey === null) return UNMAPPED
    const res = resolveRepo(mapping, s.repoKey, s.rootHash)
    if (res.kind === 'unmapped') return UNMAPPED
    if (res.kind === 'ignored') return IGNORED
    if (res.kind === 'nonRd') return NON_RD
    return pretag(mapping, res.component, s.repoKey, s.branch === null ? [] : [s.branch]).activity === 'non_qualified' ? NON_RD : null
  }
  const statusText = (status: string): string => (status === 'pretag' ? 'provisional' : status)

  // --- events.csv ---------------------------------------------------------------------------
  const eventRows: { key: [number, string, string, number]; cells: (string | number)[] }[] = []
  for (const s of input.segments) {
    const bucket = bucketOf(s)
    for (const ev of s.events) {
      if (!tsInScope(ev.ts)) continue
      const where = bucket === null ? [s.repoKey ?? '', s.rootHash ?? '', branchAt(s, ev.ts) ?? ''] : [bucket, bucket, bucket]
      eventRows.push({ key: [ev.ts, s.sessionId, s.seg, ev.seq], cells: [clock.date(ev.ts), clock.iso(ev.ts), s.sessionId, s.seg, ev.seq, ...where, ev.origin, ev.admit, ev.reason, ev.queued] })
    }
  }
  eventRows.sort((a, b) => cmp(a.key[0], b.key[0]) || cmp(a.key[1], b.key[1]) || cmp(a.key[2], b.key[2]) || cmp(a.key[3], b.key[3]))
  const eventsFile = csv('events.csv', eventRows.map(r => r.cells), { repoKey: CAP.repoKey, branch: CAP.branch, origin: CAP.origin, reason: CAP.reason })

  // --- blocks.csv ----------------------------------------------------------------------------
  const blocks = input.blocks.filter(b => isDate(b.date) && inScope(b.date)).slice().sort((a, b) => a.startTs - b.startTs || a.endTs - b.endTs)
  const blocksFile = csv('blocks.csv', blocks.map(b => [b.date, clock.iso(b.startTs), clock.iso(b.endTs), finiteCount(b.seconds), b.events.length, oneLine(input.method, 40), b.flags.map(f => oneLine(f, 20)).join(';')]))

  // --- allocations.csv ---------------------------------------------------------------------
  const allocs = input.allocations.filter(a => isDate(a.date) && inScope(a.date)).slice().sort((a, b) => cmp(a.date, b.date) || a.blockStartTs - b.blockStartTs || cmp(a.sessionId, b.sessionId) || cmp(a.seg, b.seg) || cmp(a.component, b.component))
  const allocRows: (string | number | boolean)[][] = []
  for (const a of allocs) {
    const confirmed = confirmedOf(isoWeekOfDate(a.date))
    const st = rowStatus(confirmed, `${a.component}|${a.date}`, liveByKey.get(`${a.component}|${a.date}`) ?? 0, a.entity)
    const tag = tagOf(a)
    allocRows.push([a.date, clock.iso(a.blockStartTs), a.sessionId, a.component, a.entity, finiteCount(a.seconds), tag.activity, tag.poe, statusText(st.status), confirmed ? confirmed.rev : ''])
  }
  const allocationsFile = csv('allocations.csv', allocRows)

  // --- hours_by_component.csv: per (week, component, entity, activity, poe) -------------------
  type HoursRow = { week: string; component: string; entity: string; activity: Activity; poe: boolean; live: number; frozen: number; frozenKeys: Set<string>; changed: boolean }
  const hours = new Map<string, HoursRow>()
  const hoursRow = (week: string, component: string, entity: string, activity: Activity, poe: boolean): HoursRow => {
    const key = [week, component, entity, activity, String(poe)].join('|')
    const row = hours.get(key) ?? { week, component, entity, activity, poe, live: 0, frozen: 0, frozenKeys: new Set<string>(), changed: false }
    hours.set(key, row)
    return row
  }
  const weeksWithRows = new Set<string>()
  for (const a of allocs) {
    const week = isoWeekOfDate(a.date)
    weeksWithRows.add(week)
    const tag = tagOf(a)
    const row = hoursRow(week, a.component, a.entity, tag.activity, tag.poe)
    row.live += finiteCount(a.seconds)
    const confirmed = confirmedOf(week)
    const rowKey = `${a.component}|${a.date}`
    const st = rowStatus(confirmed, rowKey, liveByKey.get(rowKey) ?? 0, a.entity)
    if (st.status === 'changed') row.changed = true
    if (st.confirmedSeconds !== null && !row.frozenKeys.has(rowKey)) {
      row.frozenKeys.add(rowKey)
      row.frozen += st.confirmedSeconds
    }
  }
  // Frozen rows with no live seconds any more are shown, never dropped (DBM-1).
  for (const week of [...reviewsByWeek.keys()].sort()) {
    const confirmed = confirmedOf(week)
    if (!confirmed) continue
    for (const rowKey of Object.keys(confirmed.rows).sort()) {
      const [component, date] = rowKey.split('|') as [string, string]
      if (!isDate(date) || !inScope(date) || liveByKey.has(rowKey)) continue
      weeksWithRows.add(week)
      const frozen = confirmed.rows[rowKey] as ReviewRevision['rows'][string]
      const row = hoursRow(week, component, frozen.entity, frozen.activity, frozen.poe)
      row.changed = true
      if (!row.frozenKeys.has(rowKey)) {
        row.frozenKeys.add(rowKey)
        row.frozen += finiteCount(frozen.seconds)
      }
    }
  }
  const hoursRows = [...hours.values()].sort((a, b) => cmp(a.week, b.week) || cmp(a.component, b.component) || cmp(a.entity, b.entity) || cmp(a.activity, b.activity) || cmp(String(a.poe), String(b.poe)))
  const hoursFile = csv('hours_by_component.csv', hoursRows.map(r => {
    const confirmed = confirmedOf(r.week)
    const status = confirmed === null ? 'provisional' : r.changed ? 'changed' : 'confirmed'
    return [r.week, r.component, r.entity, confirmed === null ? '' : r.frozen, r.live, r.activity, r.poe, status, confirmed ? confirmed.rev : '', confirmed?.confirmedLagDays ?? '']
  }))
  const provisionalWeeks = [...weeksWithRows].filter(w => confirmedOf(w) === null).sort()
  const changedRows = hoursRows.filter(r => confirmedOf(r.week) !== null && r.changed).length

  // --- activity_notes.csv: the confirmed revision's notes, else the latest draft's ----------
  const noteRows: [string, string, string][] = []
  for (const [week, review] of [...reviewsByWeek.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    if (!weekDateList(week).some(inScope)) continue
    const rev = latestConfirmed(review) ?? latestRevision(review)
    if (!rev) continue
    for (const key of Object.keys(rev.notes).sort()) {
      const [component, noteWeek] = key.split('|') as [string, string | undefined]
      if (noteWeek !== week) continue
      noteRows.push([week, component, rev.notes[key] as string])
    }
  }
  const notesFile = csv('activity_notes.csv', noteRows, { note: CAP.note })

  // --- turns.csv -----------------------------------------------------------------------------
  const turnRows: { key: [number, string, string, number]; cells: (string | number | boolean)[] }[] = []
  for (const s of input.segments) {
    for (const t of s.turns) {
      if (!tsInScope(t.ts)) continue
      const ttl = ttlAt(s, t.ts) ?? input.defaultTtl
      const price = pricing.priceTurn(t, ttl)
      const usd = price.priced && price.usd !== null && Number.isFinite(price.usd) ? price.usd.toFixed(6) : ''
      turnRows.push({ key: [t.ts, s.sessionId, s.seg, t.seq], cells: [clock.iso(t.ts), clock.iso(t.endTs), s.sessionId, s.seg, t.seq, t.agent, t.model ?? '', t.in, t.out, t.cr, t.cw, ttl, usd, price.priced] })
    }
  }
  turnRows.sort((a, b) => cmp(a.key[0], b.key[0]) || cmp(a.key[1], b.key[1]) || cmp(a.key[2], b.key[2]) || cmp(a.key[3], b.key[3]))
  const turnsFile = csv('turns.csv', turnRows.map(r => r.cells), { model: CAP.model })

  // --- spend_by_month.csv --------------------------------------------------------------------
  const spend = pricing
    .spendByMonth(input.segments, mapping, input.defaultTtl, input.zone)
    .filter(r => isMonth(r.month) && (scope.month === null ? r.month.startsWith(`${scope.year}-`) : r.month === scope.month))
    .slice()
    .sort((a, b) => cmp(a.month, b.month) || cmp(a.model, b.model) || cmp(a.component, b.component) || cmp(a.entity, b.entity))
  const spendFile = csv('spend_by_month.csv', spend.map(r => [r.month, r.model, r.component, r.entity, r.turns, finiteCount(r.in) + finiteCount(r.out) + finiteCount(r.cr) + finiteCount(r.cw), r.usd !== null && Number.isFinite(r.usd) ? r.usd.toFixed(4) : '', SPEND_LABEL]), { model: CAP.model })

  // --- monthly_log.txt -------------------------------------------------------------------------
  const months = [...new Set([...blocks.map(b => b.date.slice(0, 7)), ...allocs.map(a => a.date.slice(0, 7))])].sort()
  const logText = (months.length > 0 ? months : [scope.month ?? `${scope.year}-01`]).map(m => monthlyLogPages(m, blocks, allocs, input.zone, input.method)).join('')
  const logFile: ExportFile = { name: 'monthly_log.txt', text: logText }

  // --- JSON copies ------------------------------------------------------------------------------
  const reviewsFile: ExportFile = { name: 'reviews.json', text: `${JSON.stringify(deep('reviews.json', input.reviews), null, 2)}\n` }
  const componentsFile: ExportFile = { name: 'components.json', text: componentsText(input.mappingText, v => deep('components.json', v), r => count('components.json', r)) }
  const bridgeFile: ExportFile = { name: 'bridge.ndjson', text: input.bridgeLog.map(entry => `${JSON.stringify(deep('bridge.ndjson', entry))}\n`).join('') }

  // --- sessions.ndjson: decoded, re-encoded, rows outside the scope left out ---------------------
  // A non-claimable segment carries its bucket in place of the repository's
  // name, root hash, folder and branches, as its CSV rows do (PRV-4): the
  // segment copy must not undo the masking.
  let unencodable = 0
  const sessionLines: { id: string; seg: string; line: string }[] = []
  for (const s of input.segments) {
    const opensIn = tsInScope(s.openedAt)
    const events = s.events.filter(ev => tsInScope(ev.ts))
    const turns = s.turns.filter(t => tsInScope(t.ts))
    if (!opensIn && events.length === 0 && turns.length === 0) continue
    const decoded = decodeSession(encodeSession({ ...s, events, turns }))
    if (!decoded) {
      unencodable += 1
      continue
    }
    const bucket = bucketOf(s)
    const kept = bucket === null ? (['closeReason', 'entrypoint', 'surface', 'repoKey', 'cwdBase', 'branch', 'model'] as const) : (['closeReason', 'entrypoint', 'surface', 'model'] as const)
    for (const field of kept) {
      const after = decoded[field]
      if (typeof after === 'string' && isRedacted(after) && after !== s[field]) count('sessions.ndjson', kindOf(after))
    }
    if (bucket === null)
      decoded.branchChanges.forEach((c, i) => {
        if (c.branch !== null && isRedacted(c.branch) && c.branch !== s.branchChanges[i]?.branch) count('sessions.ndjson', kindOf(c.branch))
      })
    decoded.turns.forEach((t, i) => {
      if (t.model !== null && isRedacted(t.model) && t.model !== turns[i]?.model) count('sessions.ndjson', kindOf(t.model))
    })
    const extra = deep('sessions.ndjson', decoded.extra) as Record<string, unknown>
    const masked: SessionRecord =
      bucket === null ? { ...decoded, extra } : { ...decoded, extra, repoKey: bucket, rootHash: null, cwdBase: bucket, branch: bucket, branchChanges: decoded.branchChanges.map(c => ({ ts: c.ts, branch: bucket })) }
    sessionLines.push({ id: decoded.sessionId, seg: decoded.seg, line: encodeSession(masked) })
  }
  sessionLines.sort((a, b) => cmp(a.id, b.id) || cmp(a.seg, b.seg))
  const sessionsFile: ExportFile = { name: 'sessions.ndjson', text: sessionLines.map(l => `${l.line}\n`).join('') }

  // --- method.json --------------------------------------------------------------------------------
  const scopeRule = `A row is in the export when its local date in ${oneLine(input.zone, 64)} falls in ${scopeLabel}; a segment crossing the boundary contributes only its rows inside the period; the bridge log is the scope year's.`
  const methodFile: ExportFile = {
    name: 'method.json',
    text: `${JSON.stringify(
      {
        version: clean('method.json', input.version, 40),
        generatedAt: utcIso(input.now),
        scope: scopeLabel,
        zone: oneLine(input.zone, 64),
        method: oneLine(input.method, 40),
        params: { gapS: input.params.gapS, floorS: input.params.floorS, maxBlockS: input.params.maxBlockS, dayFlagH: input.params.dayFlagH },
        admissionVersion: clean('method.json', input.admissionVersion, 40),
        prices: PRICES,
        pricesAsOf: PRICES_AS_OF,
        cacheWriteMultiplier: CACHE_WRITE_MULTIPLIER,
        defaultTtl: input.defaultTtl,
        rounding: ROUNDING_RULE,
        scopeRule,
        unreadable: finiteCount(input.unreadable),
      },
      null,
      2,
    )}\n`,
  }

  // --- README.md (last, so it can carry every other file's redaction counts) ------------------------
  const person = clean('README.md', input.personLabel, CAP.name)
  const sha = (s: string): string => (/^[0-9a-f]{64}$/.test(s) ? s : 'unknown')
  const md = (s: string): string => s.replace(/\|/g, '\\|')
  const readme: string[] = [CAVEAT, '']
  if (provisionalWeeks.length > 0)
    readme.push(`PROVISIONAL: ${provisionalWeeks.length === 1 ? '1 week' : `${provisionalWeeks.length} weeks`} in scope ${provisionalWeeks.length === 1 ? 'has' : 'have'} no confirmed review (${provisionalWeeks.join(', ')}); those rows read \`provisional\` and may change.`, '')
  readme.push(
    `# rd-ledger export ${scopeLabel}`,
    '',
    `Person: ${person === '' ? 'not recorded — add on cover sheet' : person}`,
    `Scope: ${scopeLabel}, by local date in ${oneLine(input.zone, 64)}`,
    `Generated: ${utcIso(input.now)}`,
    `Mod version: ${clean('README.md', input.version, 40)}`,
    `union.ts sha256: ${sha(input.sources.unionSha256)}`,
    `prices.ts sha256: ${sha(input.sources.pricesSha256)}`,
    `Method: ${oneLine(input.method, 40)}`,
    `Admission version: ${clean('README.md', input.admissionVersion, 40)}`,
    `Every dollar figure is a ${ESTIMATE_LABEL} (price table as of ${PRICES_AS_OF}); it excludes the engine's side calls (compaction, titles).`,
  )
  if (changedRows > 0) readme.push(`${changedRows} hours_by_component rows changed since their week was confirmed; the frozen seconds are in confirmedSeconds.`)
  if (finiteCount(input.unreadable) > 0) readme.push(`${finiteCount(input.unreadable)} store files could not be read and are not in this export.`)
  if (unencodable > 0) readme.push(`${unencodable} segments could not be re-encoded and are not in sessions.ndjson.`)
  readme.push('', '## Files', '', ...EXPORT_FILES.map(n => `- ${n}`), '- MANIFEST.sha256 (sha256 of every file above; check with `shasum -a 256 -c MANIFEST.sha256`)')
  readme.push('', '## Data dictionary', '', '| File | Field | Meaning |', '|---|---|---|', ...DICTIONARY.map(d => `| ${d.file} | ${md(d.field)} | ${md(d.meaning)} |`))
  readme.push('', '## Engagement model and admission (SPEC §4 and §4.1, verbatim)', '', ENGAGEMENT_MODEL_TEXT)
  readme.push('', '## Retention (SPEC §3.6, verbatim)', '', RETENTION_TEXT)
  // The README's own redactions (the person label) are counted before the table is drawn.
  const redactionLines = [...tally.entries()].sort((a, b) => cmp(a[0], b[0])).flatMap(([name, byKind]) => [...byKind.entries()].sort((a, b) => cmp(a[0], b[0])).map(([kind, n]) => `| ${name} | ${kind} | ${n} |`))
  readme.push('', '## Redactions', '')
  if (redactionLines.length === 0) readme.push('No value was redacted.')
  else readme.push('Values that matched a credential, an email address or a home-folder path were replaced in place:', '', '| File | Kind | Count |', '|---|---|---|', ...redactionLines)
  const readmeFile: ExportFile = { name: 'README.md', text: `${readme.join('\n')}\n` }

  const files = [readmeFile, methodFile, eventsFile, blocksFile, allocationsFile, hoursFile, notesFile, turnsFile, spendFile, logFile, reviewsFile, componentsFile, bridgeFile, sessionsFile]
  const redactions: Record<string, number> = {}
  for (const name of EXPORT_FILES) redactions[name] = [...(tally.get(name)?.values() ?? [])].reduce((s, n) => s + n, 0)
  return { files, redactions }
}

/**
 * components.json: the mapping file as written when nothing in it needs
 * redacting; otherwise the parsed mapping re-serialized with the redactions in
 * place. Text that does not parse is copied only when it scans clean.
 */
const componentsText = (mappingText: string, redact: (v: unknown) => unknown, onRaw: (reason: string) => void): string => {
  let parsed: unknown
  try {
    parsed = JSON.parse(mappingText)
  } catch {
    // Not JSON: copied only when the joined form scans clean (verifier N2); otherwise one redaction marker stands for the file.
    const reason = scanJoined(mappingText)
    if (reason === null && !hasHomePath(mappingText)) return mappingText
    onRaw(reason ?? 'home-path')
    return `${JSON.stringify(`[redacted:${reason ?? 'home-path'}]`)}\n`
  }
  const redacted = withoutNonClaimableRepos(redact(parsed))
  return JSON.stringify(redacted) === JSON.stringify(parsed) ? mappingText : `${JSON.stringify(redacted, null, 2)}\n`
}

/**
 * PRV-4 (lead ruling 2026-10-12): the CPA copy of the mapping keeps the repo
 * keys that map to a component and drops the `ignore` and `nonRd` entries
 * (personal and non-R&D directory names have no place in the bundle), leaving
 * their counts under `_omitted`. Pre-tag rules that name an omitted repo go too.
 */
const withoutNonClaimableRepos = (parsed: unknown): unknown => {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return parsed
  const m = parsed as Record<string, unknown>
  const repos = m['repos']
  if (typeof repos !== 'object' || repos === null || Array.isArray(repos)) return parsed
  const kept: Record<string, unknown> = {}
  const omittedKeys = new Set<string>()
  let ignored = 0
  let nonRd = 0
  for (const key of Object.keys(repos as Record<string, unknown>)) {
    const rule = (repos as Record<string, unknown>)[key]
    const isObj = typeof rule === 'object' && rule !== null
    if (isObj && (rule as Record<string, unknown>)['ignore'] === true) {
      ignored += 1
      omittedKeys.add(key.split('#')[0] as string)
    } else if (isObj && (rule as Record<string, unknown>)['nonRd'] === true) {
      nonRd += 1
      omittedKeys.add(key.split('#')[0] as string)
    } else kept[key] = rule
  }
  if (ignored + nonRd === 0) return parsed
  const pretag = Array.isArray(m['pretag']) ? m['pretag'].filter(r => !(typeof r === 'object' && r !== null && omittedKeys.has(String((r as Record<string, unknown>)['repo']?.toString().split('#')[0])))) : m['pretag']
  return { ...m, repos: kept, pretag, _omitted: { ignored, nonRd, note: 'ignored and non-R&D repository entries are kept in the local store only' } }
}

/** CONTRACT (W3). `<sha256>  <name>` lines, sorted by name. */
export const manifestText = (files: readonly { name: string; sha256: string }[]): string =>
  files
    .slice()
    .sort((a, b) => cmp(a.name, b.name))
    .map(f => `${f.sha256}  ${f.name}\n`)
    .join('')
