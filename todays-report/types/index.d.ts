/** What a task was, by the most telling kind of tool it used. */
export type Kind = 'email' | 'calendar' | 'code' | 'docs' | 'design' | 'research' | 'commands' | 'agents' | 'reading' | 'other' | 'chat'

/** One day's totals, kept in $.store under `day:YYYY-MM-DD` (local date). */
export type Day = {
  /** main-loop turns that ended with an answer */
  tasks: number
  /** wall-clock length of those turns, ms */
  workMs: number
  /** API-equivalent dollars: the status line's cost across each turn, subagents included */
  usd: number
  /** input tokens (uncached, written to cache and read from it), main loop and subagents */
  tokensIn: number
  /** the part of tokensIn the prompt cache served */
  cachedIn: number
  tokensOut: number
  /** model family -> tasks it answered */
  models: Record<string, number>
  /** kind -> tasks */
  kinds: Partial<Record<Kind, number>>
}

export type Period = 'today' | 'week' | 'month' | 'year' | 'all'

/** A period's totals as the pane draws them. */
export type Report = Omit<Day, 'workMs'> & {
  period: Period
  workMs: number
  /** days in the period with at least one task */
  activeDays: number
  /** consecutive days with a task, ending today (or yesterday, before today's first) */
  streak: number
  best: number
  /** the first day anything was recorded, YYYY-MM-DD; '' before any */
  since: string
}

declare module 'claude-code' {
  interface PluginState {
    'todays-report': {
      /** the pane's report; null while it is closed */
      report: Report | null
    }
  }
}
