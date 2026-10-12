export type Offer = { savedAt: number; tasks: number }

declare module 'claude-code' {
  interface PluginState {
    checkpoint: { offer: Offer | null }
  }
}
