/** One loop's current run of identical failing calls. */
export type Streak = {
  /** tool + normalized input; a different key from the same loop starts a new streak */
  key: string
  tool: string
  /** the call as shown: the shell command, or tool + input, clipped */
  short: string
  /** consecutive identical failures so far */
  count: number
  /** first line of the last error, clipped */
  lastError: string
  /** clock time of the last failure */
  lastAt: number
  /** successful calls of other commands since the last failure; OK_RESET of them end the streak */
  okSince?: number
  /** who: 'Claude' for the main loop, the agent's description/type, or 'agent <id>' */
  label?: string
  /** reached the threshold: toasted once and drawn in the band */
  isShown: boolean
  /** the person dismissed its row; stays hidden until the streak resets */
  isDismissed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'retry-breaker': {
      /** loop ('main' or the agent id) -> its current streak */
      streaks: Record<string, Streak>
    }
  }
}
