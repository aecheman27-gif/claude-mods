/** command: the shell command text, truncated; only files it names count as its own changes, and only when it looks like it writes */
export type ShellWindow = { from: number; to: number; command: string }

declare module 'claude-code' {
  interface PluginState {
    'shared-edit-guard': {
      /** normalized path -> mtimeMs of the version this chat last read or wrote */
      seen: Record<string, number>
      /** normalized path -> mtimeMs of an outside version the user answered Cancel for; asked again until Edit anyway or it ages out */
      refused: Record<string, number>
      /** when this chat's own shell commands ran and what they said, so changes to files they name count as its own */
      shells: ShellWindow[]
    }
  }
}
