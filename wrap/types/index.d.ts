declare module 'claude-code' {
  interface PluginState {
    wrap: {
      /** Head SHA the close-out prompt was last submitted for; null when none (or released after a rejected or dropped submit). */
      submittedFor: string | null
      /** { tasks: { id, type, status }[]; crons?: { id, recurring }[]; source?: 'stop' | 'agents' } cached by the classic.Stop observer, or by the main-loop turn.complete observer from $.agent.list() where the host raises no Stop (the desktop); null until either fires. */
      backgroundTasks: unknown | null
    }
  }
}
