// The $.state contract of usage-gauge. Every key here is named by a literal
// plugin/key reference in hooks/register.tsx, and every value is JSON-safe
// (null, never undefined). The file exports types so it is a module: without a
// top-level export, `declare module` below would declare a new ambient module
// instead of augmenting 'claude-code'.

/** One rate-limit window as the engine reported it; `kind` is the engine's (`five_hour`), sanitized. */
export type RateLimitRow = { kind: string; percentUsed: number; resetsAt: string | null }

/** The status line's figures: `$.session.usage()` at start and on Refresh, `session.measure` in between. */
export type Usage = {
  /** When the session's figures count from (ms since the epoch); null when usage could not be read. */
  startedAt: number | null
  context: { tokens: number | null; window: number | null; percent: number | null }
  rateLimits: RateLimitRow[]
  /** The engine's own ledger, `cost.usd`; null before the first reading. */
  costUsd: number | null
  /** False once a reading said the host keeps no cost ledger (the chip then shows the context alone). */
  hasCost: boolean
  /** When these figures were read (ms since the epoch). */
  at: number
}

/** One row of the context breakdown, its name sanitized to one line. */
export type CategoryRow = { name: string; kind: 'used' | 'free' | 'buffer' | 'deferred'; tokens: number }

/** The window by category (`$.session.usage({ breakdown: 'summary' })`), read on pane open and Refresh. */
export type Breakdown = {
  totalTokens: number
  rawMaxTokens: number
  percentage: number
  /** Absent when auto-compaction is off. */
  autoCompactThreshold: number | null
  isAutoCompactEnabled: boolean
  model: string
  categories: CategoryRow[]
}

/** The session's running totals since the mod loaded (`loadedAt`); a hot reload keeps them. */
export type Totals = {
  loadedAt: number
  /** The last time an accounting hook wrote (ms): the pane's "now" for the session length. */
  updatedAt: number
  /** Main-loop turns. */
  turns: number
  /** Subagent turns. */
  agentTurns: number
  /** Model requests (`turn.step`) in every loop. */
  requests: number
  /** Main-loop turn wall time. */
  activeMs: number
  /** Every request's wall time, summed across every loop (overlaps count twice). */
  apiMs: number
  linesAdded: number
  linesRemoved: number
  edits: number
}

/** Token counts and time for one model or one loop. */
export type Counts = {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  apiMs: number
  /** List-price estimate of the requests the price table knows (USD). */
  estUsd: number
  /** Requests whose model the price table does not know (not in `estUsd`). */
  unpriced: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-gauge': {
      usage: Usage | null
      breakdown: Breakdown | null
      totals: Totals
      /** By sanitized model id. */
      models: Record<string, Counts>
      /** The main loop, and the subagents by their agent type. */
      loops: { main: Counts; agents: Record<string, Counts> }
      /** agentId -> agent type, the latest 500 ids. */
      agentTypes: Record<string, string>
      /** A Refresh is in flight: the button reads Refreshing. */
      refreshing: boolean
    }
  }
}
