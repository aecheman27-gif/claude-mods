/**
 * One question you asked, and the transcript rows of Claude's reply to it.
 * `isClosed`: a prompt you didn't type (a task notification, a plugin, another
 * agent) came after it, so the response rows that follow aren't its answer.
 */
export type Entry = { n: number; id: string; question: string; firstAnswerId?: string; answerId?: string; preview?: string; isClosed?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'qa-jump': { entries: Entry[] }
  }
}
