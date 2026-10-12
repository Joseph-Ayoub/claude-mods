// The $.state contract of the stall-watch mod. Every key the hooks module
// reads or writes through $.state is declared here, by literal plugin/key.

/** One rate-limit window as the last session.measure reported it. */
export type StallWatchWindow = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * The last main-loop StopFailure: when, the engine's error kind, and whether a
 * turn.complete has already been paired with it (so it is acted on once).
 */
export type StallWatchFailure = { at: number; kind: string; isContextOverflow: boolean; isHandled: boolean }

/** A main-loop turn.complete that ended with reason 'error'. */
export type StallWatchErrorTurn = { at: number; turnId: string }

/** An auto-retry that is armed but has not fired yet. */
export type StallWatchPending = { dueAt: number; attempt: number; armedAt: number }

/** A resume-after-reset that is armed but has not fired yet. */
export type StallWatchResumeArm = { resetsAt: string; dueAt: number; armedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'stall-watch': {
      failure: StallWatchFailure | null
      errorTurn: StallWatchErrorTurn | null
      /**
       * Automated submits (auto-retries and resumes, one shared cap) made since
       * the person's last prompt (composer, bridge or sdk origin).
       */
      attempts: number
      pending: StallWatchPending | null
      /** Epoch ms of the person's last prompt, composer, bridge or sdk (0 = none yet). */
      lastComposerAt: number
      /** Origin kind of the prompt that started the current/last main turn. */
      lastOrigin: string | null
      /**
       * Redacted excerpt (promptExcerpt) of the person's last prompt,
       * held in memory only, for the resume note; never the raw text.
       */
      lastPrompt: string | null
      windows: StallWatchWindow[]
      isStatusShown: boolean
      /** Local UTC offset in minutes from `date +%z`; null when it could not be read. */
      tzOffsetMin: number | null
      resumeEnabled: boolean
      resumeArm: StallWatchResumeArm | null
      /** kind|resetsAt of the window the resume note was last written for. */
      noteKey: string | null
      /**
       * Session id of the conversation everything above belongs to; null until
       * adopted, and after a session.end that moved the process on.
       */
      owner: string | null
      /**
       * turnId of the running turn the person's last prompt (composer, bridge, sdk) was
       * typed over (prompt.submit's `turnId`); a failure of that turn is not
       * retried, as the prompt runs next.
       */
      composerTurnId: string | null
    }
  }
}
