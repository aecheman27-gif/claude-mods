export type Pending = { id: number; rule: string; isEditing: boolean }

declare module 'claude-code' {
  interface PluginState {
    'reflect-lite': { pending: Pending[] }
  }
}
