export type GitInfo = { repo: string; branch: string }
export type Output = { id: string; tool: string; label: string; tokens: number }
export type Fill = { tokens?: number; window: number; percent?: number }
export type Category = { name: string; tokens: number }
export type Call = { tool: string; label: string }

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      clean: boolean
      git: GitInfo | null
      /** the main loop's model id, as /model shows it */
      model: string
      guard: boolean
      /** the effort the last main-loop request was sent with, or the level just picked */
      effort: string
      /** whether this build has an /effort command; without it the pick is applied per request */
      hasEffortCommand: boolean
      /** the level applied per request when there is no /effort command */
      override: string
      /** tool outputs in the live window, estimated */
      outputs: Output[]
      /** main-loop tool calls the model made whose result has not been stored yet, by tool_use_id */
      pending: Record<string, Call>
      fill: Fill | null
      categories: Category[]
      /** whether the [CTX] row shows */
      ctxBand: boolean
    }
  }
}
