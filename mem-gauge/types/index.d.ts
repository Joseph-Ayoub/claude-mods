// The $.state contract of mem-gauge. Every key here is named by a literal
// plugin/key reference in hooks/register.tsx, and every value is JSON-safe
// (null, never undefined). The file exports types so it is a module: without a
// top-level export, `declare module` below would declare a new ambient module
// instead of augmenting 'claude-code'.

/** macOS memory pressure, from kern.memorystatus_level (percent free). */
export type Pressure = 'ok' | 'warn' | 'critical' | 'unknown'

/** One machine-wide reading; a field the collector could not read is null. */
export type MachineStats = {
  /** When the reading was taken (ms since the epoch). */
  at: number
  totalBytes: number | null
  cores: number | null
  /** (active + wired + compressor-occupied) pages x page size: Activity Monitor's "Memory Used". */
  usedBytes: number | null
  /** (free + speculative) pages x page size. */
  freeBytes: number | null
  /** Pages occupied by the compressor x page size. */
  compressedBytes: number | null
  usedPercent: number | null
  pressure: Pressure
  swapUsedBytes: number | null
  swapTotalBytes: number | null
  load1: number | null
  diskFreeBytes: number | null
  diskTotalBytes: number | null
}

/**
 * live: fresh heartbeat; stale: heartbeat older than 120 s; gone: its process
 * has exited. An unreadable (half-written) heartbeat has no row at all until a
 * later tick reads it whole, or it is collected.
 */
export type SessionStatus = 'live' | 'stale' | 'gone'

/** One Claude session as the registry describes it, ready to draw. */
export type SessionRow = {
  sessionId: string
  label: string
  model: string
  rssMB: number | null
  contextPercent: number | null
  /** Input tokens the last response was answered over, and the model's window; null when unknown (an older build's heartbeat, a fresh session). */
  contextTokens: number | null
  contextWindow: number | null
  rateLimitPercent: number | null
  agents: number
  idleMinutes: number | null
  status: SessionStatus
  isThis: boolean
  /**
   * False for a session listed from the engine's own record
   * (~/.claude/sessions/<pid>.json): its name, memory and idle time only; no
   * model, context, agents, and no Ask to wrap. True, or absent in a row an
   * earlier build kept in $.state, for a session that runs mem-gauge.
   */
  hasMod?: boolean
}

/** A non-Claude app, its helper processes rolled up under it. */
export type AppUsage = { name: string; rssMB: number; processes: number }

/** What the tick last saw; render reads only this, never a process. */
export type Snapshot = {
  at: number
  sessionId: string
  machine: MachineStats
  /** This session's engine plus all its descendants; null when the engine pid could not be verified. */
  thisSessionMB: number | null
  sessions: SessionRow[]
  /** Claude Code engines running without mem-gauge, summed; null when ps could not be read. */
  unregistered: { count: number; rssMB: number } | null
  /** The largest non-Claude apps; every Claude session's process tree is left out. */
  topApps: AppUsage[]
}

/** One mounted volume from `df -kP`; the pseudo filesystems and the sealed-system helpers are left out. */
export type VolumeRow = { mount: string; name: string; totalBytes: number; usedBytes: number; freeBytes: number }

/** One of the usual disk hogs, measured with `du -sk` when the disk pane opens; null when missing or too slow. */
export type FolderSize = { path: string; label: string; bytes: number | null }

/** What the disk pane shows; read on open and on Refresh, never on the tick. */
export type DiskReport = { at: number; volumes: VolumeRow[]; folders: FolderSize[] }

/** Another session's operator asked this one to wrap up (Fix A: a file, never a model message). */
export type WrapRequest = { at: number; freesMB: number | null }

/** This session's context and rate-limit figures, pushed by session.measure. */
export type Figures = {
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number | null
  rateLimitPercent: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'mem-gauge': {
      snapshot: Snapshot | null
      /** The verified engine pid; null until checked or when the check failed. */
      enginePid: number | null
      /** The engine pid has been probed once (whatever the outcome), so ticks do not re-probe. */
      pidChecked: boolean
      /** Last main-loop activity (turn.start / main turn.complete), ms since the epoch; 0 before any. */
      lastActivityAt: number
      /** sessionId -> when this session last sent it an "Ask to wrap" (ms). */
      asked: Record<string, number>
      /** "<repo basename> · <branch>", refreshed on session.start and main turn.complete. */
      label: string | null
      figures: Figures | null
      wrapRequest: WrapRequest | null
      /** The pane lists every active session instead of the top ten (View all pressed). */
      showAllSessions: boolean
      disk: DiskReport | null
      /** Apply actions running now, by tip key: the pane draws their button as Applying and ignores a second press. */
      applying: string[]
    }
  }
}
