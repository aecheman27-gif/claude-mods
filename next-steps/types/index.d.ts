export type Step = { label: string; prompt: string }
export type Card = { question?: string; steps: Step[] }

declare module 'claude-code' {
  interface PluginState {
    'next-steps': { card: Card | null }
  }
}
