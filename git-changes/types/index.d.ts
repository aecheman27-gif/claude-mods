export type FileChange = { path: string; code: string; from?: string; added?: number; removed?: number; isBinary?: boolean }
export type Commit = { hash: string; subject: string; when: string }
export type Status = {
  branch: string
  upstream?: string
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  untracked: string[]
  conflicts: string[]
  commits: Commit[]
  stashes: number
}
export type Snapshot = { status: Status | null; problem: string | null; at: number }

declare module 'claude-code' {
  interface PluginState {
    'git-changes': { snapshot: Snapshot | null }
  }
}
