/** Who this session is on its repo's merge lane, as last read from disk. */
export type LaneRole = 'holder' | 'queued' | 'none'

/** Why a queue entry exists: the person's /lane request, or the gate queuing a refused merge. */
export type QueueSource = 'request' | 'gate'

/** One waiting session's request, as written to <lane>/queue/<sessionId>.json by that session alone. */
export type LaneQueueEntry = {
  sessionId: string
  label: string
  pr: string | null
  priority: 'high' | 'normal'
  requestedAt: number
  nonce: string
  source: QueueSource
}

declare module 'claude-code' {
  interface PluginState {
    'merge-lane': {
      /** The lane this session last resolved (16 hex of the remote's SHA-256), or null when inert. */
      repoKey: string | null
      role: LaneRole
      pr: string | null
      /** The nonce of the queue request that won the lane, or of the one still waiting. */
      nonce: string | null
      /** Nonces whose proceed prompt was already submitted, newest last (capped). */
      notifiedNonces: string[]
      /** The session id the values above belong to; a /clear rotates the id and voids them. */
      sessionId: string | null
      /** This session's own queue entry, kept so a wrongly pruned live entry is re-asserted. */
      entry: LaneQueueEntry | null
      /** /lane auto on|off for this session; null follows the auto option. */
      autoOverride: boolean | null
      /** /lane off: the gate lets this session merge without the lane. */
      isBypassed: boolean
      /** When the holder last polled its PR's state (ms since epoch). */
      polledAt: number
      /** The main loop's running turn, so /lane take never opens a dialog mid-turn. */
      turnId: string | null
    }
  }
}
