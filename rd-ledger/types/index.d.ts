// The $.state contract and the shared record types of rd-ledger (SPEC v1.1 §3, §10).
// Every key under PluginState is named by a literal plugin/key reference in
// hooks/register.tsx and every value is JSON-safe (null, never undefined). The
// record types are the store format and the contract between the pure modules;
// a builder who needs a field not here proposes it to the lead in its return.

/** rd-tracker's claim classes for a (component, date). */
export type Activity = 'direct_research' | 'direct_support' | 'non_qualified'

/** One human prompt submission with its admission verdict (SPEC §4). */
export type EngagementEvent = {
  /** Monotonic within the segment; the row key is `sessionId|seg|seq` */
  seq: number
  /** ms since the epoch at Enter */
  ts: number
  /** `origin.kind` as the engine stamped it, cleaned */
  origin: string
  admit: 0 | 1
  /** `human` | `human-desktop-host` | `sdk-nested` | `automation-entrypoint` | `entrypoint-unknown` | `origin:<kind>` */
  reason: string
  /** 1 when typed while a turn ran (the enqueue moment) */
  queued: 0 | 1
}

/** One model turn's cost as the engine reported it. */
export type TurnRecord = {
  seq: number
  ts: number
  endTs: number
  turnId: string
  /** sha8 of the subagent's id, '' on the main loop; `(turnId, agentKey)` is the turn's identity */
  agentKey: string
  agent: 0 | 1
  model: string | null
  /** input, output, cache-read and cache-creation tokens */
  in: number
  out: number
  cr: number
  cw: number
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
}

export type RecordSource = 'startup' | 'resume' | 'clear' | 'fork' | 'unknown'

/** One session segment: `sessions/YYYY/MM/<sessionId>.<seg>.json`, written only by the process that opened it. */
export type SessionRecord = {
  v: 1
  sessionId: string
  /** The open time in base-36 ms; a new segment per process open and per local month */
  seg: string
  openedAt: number
  closedAt: number | null
  closeReason: string | null
  source: RecordSource
  entrypoint: string | null
  interactive: boolean
  surface: string | null
  repoKey: string | null
  repoKind: 'repo' | 'dir'
  /** First 12 hex of sha256(salt | root relative to HOME); null when unknown */
  rootHash: string | null
  cwdBase: string
  branch: string | null
  branchChanges: { ts: number; branch: string | null }[]
  model: string | null
  cacheTtlChanges: { ts: number; ttl: '5m' | '1h' }[]
  /** The next row's seq */
  nextSeq: number
  events: EngagementEvent[]
  turns: TurnRecord[]
  eventsDropped: number
  turnsDropped: number
  /** Rows a decode dropped because their shape was wrong */
  malformedRows: number
  /** Fields the boundary scan redacted while this segment was written */
  redactions: number
  engineCostAtOpen: number | null
  engineCostUsd: number | null
  /** Unknown top-level keys of the file, preserved on rewrite */
  extra: Record<string, unknown>
  updatedAt: number
}

export type Filing = 'c-corp' | 's-corp' | 'schedule-c' | 'partnership' | 'other'

export type Entity = { name: string; filing: Filing | null }

export type Component = {
  name: string
  entity: string
  activity: Activity
  poe: boolean
  /** The id this component carries in rd-tracker's registry; null when not bridged */
  rdt: string | null
}

export type RepoRule = { component: string } | { ignore: true } | { nonRd: true; entity: string }

/** `branch` is a glob: a literal, or a prefix ending in `*`; null matches every branch. */
export type PretagRule = { repo: string; branch: string | null; activity: Activity; poe: boolean }

/** `~/.claude/rd-ledger/components.json`, validated; tables are null-prototype objects in code. */
export type Mapping = {
  v: 1
  /** Incremented on every save; a save whose loaded gen differs from the file's is refused */
  gen: number
  entities: Record<string, Entity>
  components: Record<string, Component>
  /** Keys are `repoKey` or `repoKey#<rootHash12>`; the hashed form outranks the bare one */
  repos: Record<string, RepoRule>
  pretag: PretagRule[]
  /** Top-level keys the mod does not know, preserved on save */
  extra: Record<string, unknown>
}

export type Resolution =
  | { kind: 'component'; component: string; entity: string; via: 'hash' | 'bare' }
  | { kind: 'ignored'; via: 'hash' | 'bare' }
  | { kind: 'nonRd'; entity: string; via: 'hash' | 'bare' }
  | { kind: 'unmapped' }

export type QueueDecision = { component: string } | { ignore: true } | { nonRd: true; entity: string }

export type ImportedRegistry = {
  entities: Record<string, { name: string; filing: Filing | null }>
  components: Record<string, { name: string; entity: string }>
}

export type UnionParams = { gapS: number; floorS: number; maxBlockS: number; dayFlagH: number }

/** One admitted event as the union sees it. */
export type UnionEvent = { ts: number; sessionId: string; seg: string; seq: number }

/** One engagement block after the cap and midnight splits: never crosses a local day. */
export type Block = {
  date: string
  startTs: number
  endTs: number
  seconds: number
  events: UnionEvent[]
  /** `over-4h` when the pre-split chain exceeded the cap */
  flags: string[]
}

export type Allocation = {
  date: string
  blockStartTs: number
  sessionId: string
  seg: string
  /** `repoKey#hash` or the bare key as the segment names it */
  repoRef: string
  /** A component id, or `__unmapped__` / `__ignored__` / `__non_rd__` */
  component: string
  entity: string
  seconds: number
}

export type Flag = { kind: 'day-over-cap' | 'block-over-4h' | 'automation-heavy' | 'rows-dropped'; date: string; detail: string }

export type RowStatus = 'pretag' | 'confirmed' | 'changed'

export type WeekRow = {
  /** `${component}|${date}` */
  key: string
  component: string
  entity: string
  date: string
  seconds: number
  /** Seconds in the latest confirmed revision; null when none */
  confirmedSeconds: number | null
  activity: Activity
  poe: boolean
  status: RowStatus
  flags: string[]
}

export type QueueRow = {
  /** `repoKey#hash`, or the bare key when the hash is unknown */
  key: string
  repoKey: string
  rootHash: string | null
  seconds: number
  branches: string[]
  sessions: number
  /** The bare key is mapped but this hash is new (DBM-8) */
  isNewLocation: boolean
}

export type SpendRow = {
  month: string
  model: string
  component: string
  entity: string
  turns: number
  in: number
  out: number
  cr: number
  cw: number
  usd: number | null
  priced: boolean
}

export type Deadline = { date: string; label: string; entity: string | null }

export type BridgeStatus = 'off' | 'standalone' | 'unreachable' | 'corroborate' | 'source-of-truth'

export type Health = {
  zone: string
  zoneDetectedNow: string | null
  pricesAsOf: string
  sessionsInScope: number
  segmentsInScope: number
  unreadable: number
  deniedByReason: Record<string, number>
  redactions: number
  rowsDropped: number
  daysSinceExport: number | null
  storeIsLink: boolean
  /** Age in ms of a store lock older than the stale threshold (a crashed session's); null when no stale lock is held. Cleared by the person, never taken over. */
  lockStaleMs: number | null
  bridge: BridgeStatus
  readOnly: boolean
}

export type ReviewStatus = { week: string; confirmed: boolean; rev: number; changedRows: number }

export type EngineCost = { usd: number; segments: number }

/** Input, output, cache-read and cache-write token counts. */
export type TokenCounts = { in: number; out: number; cr: number; cw: number }

/** What a recommendation is about; one pure rule in rollup.ts per code. */
export type RecommendationCode = 'cache-ttl-1h' | 'cache-ttl-5m' | 'agent-tier' | 'context-size' | 'errored-turns' | 'cost-per-hour'

/** One plain sentence on spending less; every figure in it is a list-price estimate. */
export type Recommendation = { code: RecommendationCode; text: string; estSavingUsd: number | null }

/** One agent of a session: the main loop (agentKey ''), a subagent (sha8 of its id), or `others`, the subagents past the twelfth folded into one row. */
export type AgentSummary = {
  agentKey: string
  /** How many agents an `others` row folds together; 0 on every other row */
  merged: number
  turns: number
  /** The model it used most (ties to the smaller id); null when no turn named one */
  model: string | null
  tokens: TokenCounts
  /** List-price estimate of its priced turns; null when it has turns and none could be priced */
  estUsd: number | null
  /** 0–1 of the session's estUsd; 0 when the session has no estimate */
  share: number
}

/** One session (every segment of one sessionId in scope) for the Session and Sessions views. */
export type SessionSummary = {
  sessionId: string
  /** The first 8 characters of the id, the handle `/rd session <id8>` takes */
  id8: string
  openedAt: number
  /** The latest row, open or close time seen across its segments */
  lastAt: number
  /** The latest segment's repository key (cleaned at the boundary); null when none */
  repoKey: string | null
  entrypoint: string | null
  segments: number
  /** union-v2 over this session's own admitted events with the rollup's params */
  engagedS: number
  /** Admitted human prompts */
  prompts: number
  turnsMain: number
  turnsAgent: number
  tokens: TokenCounts
  /** Sum of the priced turns at the TTL in force per turn; null when it has turns and none could be priced */
  estUsd: number | null
  /** Turns whose model has no price row (named in the view, never guessed) */
  unpricedTurns: number
  /** The engine's cumulative /cost figure in the session's latest segment (its most recent process); an earlier process of a resumed session is not included; null until that process reports */
  engineUsd: number | null
  /** By estimate, at most 8; models past the eighth fold into one `others` row whose `merged` counts them */
  models: { model: string; turns: number; estUsd: number | null; merged: number }[]
  /** Main loop first, then subagents by estimate, at most 12 subagents plus one `others` row */
  agents: AgentSummary[]
  recommendations: Recommendation[]
}

/** One row of the Sessions view: what the list draws, kept small so 300 of them fit in state. */
export type SessionRow = {
  sessionId: string
  id8: string
  openedAt: number
  lastAt: number
  repoKey: string | null
  engagedS: number
  /** Main and agent turns */
  turns: number
  /** Subagents seen */
  agentCount: number
  engineUsd: number | null
  estUsd: number | null
  recCount: number
}

/** One local day: net is the union-v2 seconds allocated to it, gross the span from its first to its last admitted event (0 for a one-event day). */
export type DayFigure = { date: string; netS: number; grossS: number }

/** One ISO week of the R&D view's trend; `confirmed` is null when its review file was not read (the register reads this and last week's). */
export type WeekTrendRow = { week: string; netS: number; grossS: number; confirmed: boolean | null }

/** This week's seconds per entity id, or per bucket (`__unmapped__`, `__ignored__`, `__non_rd__`) so the rows add up to the week. */
export type EntityHours = { entity: string; seconds: number }

/** This week's seconds per component (or bucket); `activity` is `mixed` when its days disagree, null for a bucket. */
export type ComponentHours = { component: string; entity: string; activity: Activity | 'mixed' | null; seconds: number }

/** This week's seconds per claim class; unmapped time is `unclassified`; `poeS` is the part with POE on. */
export type ActivityHours = { activity: Activity | 'unclassified'; seconds: number; poeS: number }

/** A day a rollup flag names, with that day's figures, for the R&D view's "Days to adjudicate". */
export type FlaggedDay = { date: string; reason: Flag['kind']; netS: number; grossS: number }

/** What the pane and the footer draw; computed by rollup.ts, never while drawing. */
export type Rollup = {
  at: number
  zone: string
  method: string
  params: UnionParams
  week: string
  today: string
  weekRows: WeekRow[]
  weekTotalS: number
  weekUnmappedS: number
  weekIgnoredS: number
  todayS: number
  queue: QueueRow[]
  spendMonth: SpendRow[]
  spendLastMonth: SpendRow[]
  spendMonthUsd: number | null
  engineCost: EngineCost | null
  deadlines: Deadline[]
  reviews: ReviewStatus[]
  flags: Flag[]
  health: Health
  /** Per day of the week, seconds (for the Compare column) */
  dayTotals: Record<string, number>
  /** Every session in scope (this and last month), newest first, at most 300, as compact rows */
  sessions: SessionRow[]
  /** Full summaries for this session, the selected one and the newest 40 rows only, by sessionId */
  details: Record<string, SessionSummary>
  /** The session this process is recording; null before its segment opens or when it is out of scope */
  thisSessionId: string | null
  /** Median list-price estimate per engaged hour over sessions with at least 0.25 h engaged; null when none */
  medianUsdPerHour: number | null
  /** This session's engine /cost figure (its SessionSummary.engineUsd), shown by the Session view; null until the engine reports */
  engineUsd: number | null
  /** This week's gross span: the per-day gross figures of its dates summed */
  weekGrossS: number
  /** Today's gross span */
  todayGrossS: number
  /** Last ISO week's net seconds, for the R&D view's delta line */
  lastWeekTotalS: number
  /** Every ISO week from the one holding the first of last month to this week, newest first */
  weekTrend: WeekTrendRow[]
  /** This week by entity, largest first; buckets carry their own rows */
  byEntity: EntityHours[]
  /** This week by component, largest first; buckets carry their own rows */
  byComponent: ComponentHours[]
  /** This week by claim class, in a fixed order, zero classes included */
  activityMix: ActivityHours[]
  /** Days the rollup flags name (every day in scope), newest first, one row per (date, reason) */
  flaggedDays: FlaggedDay[]
  /** This week's three days with the most net seconds, largest first (days with time only) */
  longestDays: DayFigure[]
  /** The mapping's entity ids, sorted, for the Section G exemption rows */
  entityIds: string[]
}

export type ConfirmedRow = { seconds: number; entity: string; activity: Activity; poe: boolean; source: 'pretag' | 'confirmed' }

export type ReviewRevision = {
  rev: number
  at: number
  kind: 'confirm' | 'reopen'
  confirmedAt: number | null
  method: string
  params: UnionParams
  zone: string
  mappingDigest: string
  inputsDigest: string
  rows: Record<string, ConfirmedRow>
  otherHours: Record<string, number | null>
  /** `${component}|${week}` → the person's note (≤ 300) */
  notes: Record<string, string>
  confirmedLagDays: number | null
}

export type ReviewFile = { v: 1; week: string; revisions: ReviewRevision[] }

export type BridgeInfo =
  | { present: false; reason: string }
  | { present: true; repo: string; python: string }

export type HandoffEntry = {
  week: string
  rev: number
  date: string
  rdtEntity: string
  rdtComponent: string | null
  /** Whole hundredths of an hour */
  hundredths: number
  activity: Activity
  poe: boolean
  note: string | null
  startIso: string | null
  endIso: string | null
}

export type BridgeLogKind = 'intent' | 'sent' | 'uncertain' | 'failed' | 'needs-manual-adjust'

export type BridgeLogEntry = {
  at: number
  kind: BridgeLogKind
  week: string | null
  rev: number | null
  date: string | null
  rdtEntity: string
  rdtComponent: string | null
  hundredths: number | null
  argv: string[]
  exitCode: number | null
  rowId: number | null
  label: string | null
  lagDays: number | null
  stdoutLine: string
}

export type HandoffPlan = { send: HandoffEntry[]; adjust: HandoffEntry[]; blocked: HandoffEntry[] }

export type CompareResult = { at: number; byDate: Record<string, number>; method: string | null }

export type View = 'session' | 'sessions' | 'overview' | 'review' | 'spend'

/** One rate-limit window as the engine reported it; `kind` is the engine's (`five_hour`), one line. */
export type RateLimitRow = { kind: string; percentUsed: number; resetsAt: string | null }

/** The session's usage figures (SPEC §6.6): `$.session.usage()` at start and on Refresh, `session.measure` in between. */
export type Usage = {
  /** When the session's figures count from (ms since the epoch); null when usage could not be read */
  startedAt: number | null
  context: { tokens: number | null; window: number | null; percent: number | null }
  rateLimits: RateLimitRow[]
  /** The engine's own ledger, `cost.usd`; null before the first reading */
  costUsd: number | null
  /** False once a reading said the host keeps no cost ledger */
  hasCost: boolean
  /** When these figures were read (ms since the epoch) */
  at: number
}

/** One row of the context breakdown, its name one line. */
export type CategoryRow = { name: string; kind: 'used' | 'free' | 'buffer' | 'deferred'; tokens: number }

/** The window by category (`$.session.usage({ breakdown: 'summary' })`), read on Usage pane open and Refresh. */
export type Breakdown = {
  totalTokens: number
  rawMaxTokens: number
  percentage: number
  /** Null when auto-compaction is off */
  autoCompactThreshold: number | null
  isAutoCompactEnabled: boolean
  model: string
  categories: CategoryRow[]
}

/** This session's running usage totals since the mod loaded (`loadedAt`); a hot reload keeps them. */
export type UsageTotals = {
  loadedAt: number
  /** The last time an accounting hook wrote (ms): the pane's "now" */
  updatedAt: number
  /** Main-loop turns */
  turns: number
  /** Subagent turns */
  agentTurns: number
  /** Model requests (`turn.step`) in every loop */
  requests: number
  /** Main-loop turn wall time */
  activeMs: number
  /** Every request's wall time, summed across every loop (overlaps count twice) */
  apiMs: number
  linesAdded: number
  linesRemoved: number
  edits: number
}

/** Token counts and time for one model or one loop. */
export type UsageCounts = {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  apiMs: number
  /** List-price estimate of the priced requests (USD), each at the cache TTL in force when it ran */
  estUsd: number
  /** Requests whose model the price table does not know (not in `estUsd`) */
  unpriced: number
}

declare module 'claude-code' {
  interface PluginState {
    'rd-ledger': {
      /** Shape-tagged, so a reload of older code's rollup reads as absent rather than missing fields */
      rollup: Shaped<Rollup | null>
      view: View
      /** The session the Session view shows (a full sessionId); null shows this process's own */
      selectedSession: string | null
      /** Rows the Sessions view lists and offers in its picker: 40, +40 per More, at most 300 */
      sessionsShown: number
      /** 'refresh' | 'export' | 'bridge' | 'import' | 'compare' while one runs; a second press is ignored */
      busy: string | null
      /** One cleaned line about the last failure */
      lastError: string | null
      /** Review drafts not yet confirmed: row key → activity/poe */
      pendingRows: Record<string, { activity: Activity; poe: boolean }>
      /** Note fields as typed: `${component}|${week}` → text */
      draftNotes: Record<string, string>
      /** Other-hours fields as typed: entity id → text */
      draftOtherHours: Record<string, string>
      /** The open segment's path, so a hot reload continues the same file; null before one opens */
      recordPath: string | null
      /** The refresh timer's owner token; arming is idempotent across reloads */
      armToken: string | null
      /** The last Compare result for the Review view */
      compare: CompareResult | null
      /** The Usage pane (SPEC §6.6): the engine's figures, no text field */
      usage: Shaped<Usage | null>
      /** The context window by category, read on Usage open and Refresh */
      breakdown: Shaped<Breakdown | null>
      /** This session's request, turn, time and edit counts */
      usageTotals: Shaped<UsageTotals>
      /** By model id (one line, ≤ 32); at most 50 keys, any more fold into `other` */
      models: Shaped<Record<string, UsageCounts>>
      /** The main loop, and the subagents by agent type (≤ 24); at most 50 types, the rest `other` */
      loops: Shaped<{ main: UsageCounts; agents: Record<string, UsageCounts> }>
      /** agentId (≤ 128) → agent type, the latest 500 ids; `$.agent.list` is read for id and type only */
      agentTypes: Record<string, string>
      /** A Usage Refresh is in flight: the button reads Refreshing */
      usageRefreshing: boolean
    }
  }
}
