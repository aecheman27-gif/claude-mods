export type Settings = {
  /** More subagents running than this warns (and, with caps on, asks before another starts). */
  maxConcurrent: number
  /** Tokens one subagent may use before it warns (and, with caps on, is told to hand back). */
  agentBudget: number
  /** Tokens all subagents of the session may use before it warns. */
  sessionBudget: number
  /** Opt-in enforcement: ask before spawning past maxConcurrent, deny tool calls of an agent over budget. */
  caps: boolean
  /** Opt-in routing: subagent type -> model, applied only when the spawn named no model. */
  routes: Record<string, string>
}

export type Tracked = {
  id: string
  type: string
  /** `Explore#2`: the type and its ordinal this session. */
  label: string
  description: string
  startedAt: number
  endedAt?: number
  tokens: number
  isRunning: boolean
  /** When this record last changed from an event of its own (spawn, step, completion). */
  touchedAt: number
}

export type Gov = {
  agents: Record<string, Tracked>
  peak: number
  spawned: number
  /** Every subagent token counted this session, pruned agents included. */
  sessionTokens: number
  perType: Record<string, number>
  settings: Settings
}

declare module 'claude-code' {
  interface PluginState {
    'agent-governor': { gov: Gov }
  }
}
