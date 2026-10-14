/** A model family auto-model routes to. */
export type Family = 'haiku' | 'sonnet' | 'opus'

/** The last turn auto-model answered on another model than the session's own. */
export type Routed = {
  /** who answered */
  family: Family
  /** the session's own model family, what Redo runs on */
  base: string
  /** the rule that picked it: 'quick question', '"build"', ... */
  why: string
  /** the prompt as sent, for Redo */
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    'auto-model': {
      /** drawn as the [AUTO] row until the next prompt or Dismiss */
      last: Routed | null
    }
  }
}
