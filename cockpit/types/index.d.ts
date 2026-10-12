// The cockpit band's session state: every $.state key the hooks module names,
// held by the host for the session so it survives a hot reload. Any plugin can
// read these values, so none of them carries raw prompt text except the rule
// sentence the person is asked to confirm (shown verbatim before any write).

/** A quick reply the band has handed to $.prompt.submit and not yet seen start. */
export type CockpitPending = { text: string; at: number }

/** One recent composer prompt, by the SHA-256 of its normalized text (never the text). */
export type CockpitRecent = { hash: string; at: number }

/** The CI rollup as the band shows it: anything empty or unrecognized is `pending`, never `green`. */
export type CockpitCi = 'green' | 'failing' | 'pending'

/** The pull request for the session's branch, as `gh pr view --json` reported it. */
export type CockpitPr = {
  number: number
  state: string
  mergeable: string
  mergeState: string
  ci: CockpitCi
  isMerged: boolean
  /** The PR head commit (`headRefOid`); null when gh did not say. A merged PR counts as done only at this exact HEAD. */
  headSha: string | null
  /** When GitHub merged it (`mergedAt`), ms since the epoch; null when not merged or unreadable. */
  mergedAt: number | null
}

/**
 * The standing line's last refresh. `prStatus` says how the PR lookup went:
 * `ok` (pr set), `none` (no PR for the branch), `error` (the CLI ran and failed),
 * `unavailable` (the CLI could not start), `skipped` (git failed, so no lookup).
 */
export type CockpitStanding = {
  branch: string | null
  pr: CockpitPr | null
  prStatus: 'ok' | 'none' | 'error' | 'unavailable' | 'skipped'
  refreshedAt: number
  /** `git status --porcelain` empty; null when git could not say. */
  isClean: boolean | null
  /** Entries `git status --porcelain` listed (modified and untracked alike); null when git could not say. */
  dirtyFiles: number | null
  /** `git rev-parse HEAD`; null when git could not say. */
  headSha: string | null
  /** Commits on HEAD not on its upstream (`git rev-list --count @{u}..HEAD`); null without an upstream or when git could not say. */
  aheadOfUpstream: number | null
  /** Whether the repository has any remote (`git remote` lists one); null when git could not say. A repository with none has nowhere to push or merge: a clean tree is as done as it gets. */
  hasRemote: boolean | null
  /** The remote's default branch (`origin/main`), from `refs/remotes/origin/HEAD`; null when unknown. */
  defaultBranch: string | null
  /** HEAD is contained in the remote default branch (`git merge-base --is-ancestor`); null when git could not say. */
  inDefault: boolean | null
  /** When the PR was merged: GitHub's `mergedAt`, else the refresh that first saw it merged (kept while the same PR stays merged); the lead must be told after this. */
  mergedSeenAt: number | null
  /** The `seq` and `token` of the last main-loop Stop seen when this refresh started: readings count only for that exact Stop. */
  stopSeq: number
  stopToken: string
  /** With no PR: when a refresh first saw HEAD in the remote default branch (kept while it stays so on the same branch); the lead must be told after this. */
  inDefaultSeenAt: number | null
}

/**
 * What the host told the band: whether the app's archive tool is listed, the parent (lead)
 * session, and whether the handoff mod's `/handoff` command is listed. `leadState` is `unknown`
 * until the app's record was read once; a later failed read never clears a lead it knew.
 * `handoffCommand` is absent in state saved by cockpit 0.1.x: read it as false.
 */
export type CockpitHost = { archiveTool: boolean; lead: string | null; leadState: 'unknown' | 'none' | 'known'; handoffCommand: boolean }

/**
 * The live context window as last measured (`session.measure`, or `$.session.usage()` after a
 * main-loop turn): `tokens` the fill, null until a response reported one (and after /clear);
 * `window` the model's window, null when unknown; `startedAt` when the session these figures count
 * from began (`$.session.usage().startedAt`, which /clear starts over), null until read and set back to null by a /clear until read again. Absolute
 * tokens drive the Hand off chip; `startedAt` keeps a merge from before the session from being a break.
 */
export type CockpitContext = { tokens: number | null; window: number | null; at: number; startedAt: number | null }

/**
 * Background work an archive would drop, as last observed after the latest turn; null until then.
 * `source` 'stop': the main-loop classic.Stop listed tasks and wakeups. `source` 'agents': the host
 * raises no classic.Stop (the desktop), so `tasks` is the running subagents from `$.agent.list()` and
 * `crons` is unknown (0): background shell tasks and wakeups stay the app's to guard there.
 * `seq` counts observations this load; `token` marks the load.
 */
export type CockpitBackground = { tasks: number; crons: number; at: number; seq: number; token: string; source: 'stop' | 'agents' }

export type CockpitOption = { value: string; label: string }

/** One option question parsed from the last answer; `picked` is the person's Select choice. */
export type CockpitQuestion = {
  number: number
  text: string
  options: CockpitOption[]
  recommended: string | null
  picked: string | null
}

export type CockpitCards = { turnId: string; questions: CockpitQuestion[] }

export type CockpitWaiting = { id: string; text: string }

/** A standing-rule sentence detected in the person's prompt, awaiting their choice of file. */
export type CockpitRule = { sentence: string; detectedAt: number }

/** Which band sections are folded to their toggle alone. */
export type CockpitCollapsed = {
  replies: boolean
  standing: boolean
  cards: boolean
  waiting: boolean
  rule: boolean
}

declare module 'claude-code' {
  interface PluginState {
    cockpit: {
      pending: CockpitPending | null
      recent: CockpitRecent[]
      standing: CockpitStanding | null
      lastToolAt: number
      cards: CockpitCards | null
      waiting: CockpitWaiting[]
      rule: CockpitRule | null
      collapsed: CockpitCollapsed
      /** When this session last sent a message to another session (SendMessage or the app's send_message). */
      lastReportAt: number
      background: CockpitBackground | null
      host: CockpitHost
      /** The context window's fill as last measured; null until the first reading. */
      context: CockpitContext | null
    }
  }
}
