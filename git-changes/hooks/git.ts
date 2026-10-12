// Pure parsing of git's machine-readable output.

import type { Commit, FileChange, Status } from '../types'

/** `git status --porcelain=v2 --branch -z`: the branch headers and one entry per changed path. */
export function parseStatus(z: string): Omit<Status, 'commits' | 'stashes'> {
  const s: Omit<Status, 'commits' | 'stashes'> = { branch: '', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicts: [] }
  const records = z.split('\0')
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    if (!r) continue
    if (r.startsWith('# branch.head ')) s.branch = r.slice(14)
    else if (r.startsWith('# branch.upstream ')) s.upstream = r.slice(18)
    else if (r.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(r)
      if (m) {
        s.ahead = Number(m[1])
        s.behind = Number(m[2])
      }
    } else if (r.startsWith('? ')) s.untracked.push(r.slice(2))
    else if (r.startsWith('u ')) s.conflicts.push(fields(r, 10).path)
    else if (r.startsWith('1 ') || r.startsWith('2 ')) {
      const isRename = r[0] === '2'
      const { head, path } = fields(r, isRename ? 9 : 8)
      const from = isRename ? records[++i] : undefined // a rename's next record is the path it came from
      const [x, y] = head[1]
      if (x !== '.') s.staged.push(from ? { path, code: x, from } : { path, code: x })
      if (y !== '.') s.unstaged.push({ path, code: y })
    }
  }
  if (s.branch === '(detached)') s.branch = 'detached HEAD'
  return s
}

/** The first `n` space-separated fields, and the path after them (which may hold spaces). */
function fields(record: string, n: number): { head: string[]; path: string } {
  const head: string[] = []
  let at = 0
  for (let k = 0; k < n; k++) {
    const sp = record.indexOf(' ', at)
    head.push(record.slice(at, sp))
    at = sp + 1
  }
  return { head, path: record.slice(at) }
}

/** `git diff --numstat -z --no-renames`: lines added and removed per path; binary files say so. */
export function parseNumstat(z: string): Map<string, { added?: number; removed?: number; isBinary?: boolean }> {
  const out = new Map<string, { added?: number; removed?: number; isBinary?: boolean }>()
  for (const r of z.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(r)
    if (!m) continue
    out.set(m[3], m[1] === '-' ? { isBinary: true } : { added: Number(m[1]), removed: Number(m[2]) })
  }
  return out
}

export function withCounts(list: FileChange[], counts: Map<string, { added?: number; removed?: number; isBinary?: boolean }>): FileChange[] {
  return list.map(f => ({ ...f, ...(counts.get(f.path) ?? {}) }))
}

/** `git log --format=%h%x1f%s%x1f%cr`: one commit a line. */
export function parseLog(text: string): Commit[] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const [hash, subject = '', when = ''] = line.split('\x1f')
      return { hash, subject, when }
    })
}

/** What a status letter means, as `git status` words it. */
export const WORDS: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'conflict' }
