/** command: the shell command text, truncated; only files it names count as its own changes */
export type ShellWindow = { from: number; to: number; command: string }

declare module 'claude-code' {
  interface PluginState {
    'shared-edit-guard': {
      /** normalized path -> mtimeMs of the version this chat last read or wrote */
      seen: Record<string, number>
      /** when this chat's own shell commands ran and what they said, so changes to files they name count as its own */
      shells: ShellWindow[]
    }
  }
}
