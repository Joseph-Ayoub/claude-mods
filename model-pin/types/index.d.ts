// The $.state contract of model-pin. Every key here is named by a literal
// plugin/key reference in hooks/register.tsx. The file exports a type so it is
// a module: without a top-level export, `declare module` below would declare a
// new ambient module instead of augmenting 'claude-code'.

/** Where the pin in force came from: the /model-pin override or a settings source. */
export type ModelPinSource = 'override' | 'policy' | 'flag' | 'local' | 'project' | 'user'

declare module 'claude-code' {
  interface PluginState {
    'model-pin': {
      /** The one automatic re-apply of the pin this session has been spent. */
      reappliedOnce: boolean
      /** The session is on a model other than the pin (the badge is up). */
      drifted: boolean
      /** The drift toast has been shown this session; never shown twice. */
      toastShown: boolean
      /**
       * When the retry after an engine fallback is due (epoch ms), or 0 when
       * none waits. Kept here, not only in a timer, so a reload can re-arm it.
       */
      retryAt: number
    }
  }
}
