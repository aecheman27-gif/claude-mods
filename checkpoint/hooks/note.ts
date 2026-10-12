import type { SessionMessage } from 'claude-code'

// Pure text: the handoff note built from a transcript, its file name, and the
// few facts read back out of it. No engine calls here.

export const DIR = '.claude/handoff'
export const LATEST = 'latest.md'
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const GOAL_CHARS = 300
const ERROR_CHARS = 200
const RECENT_PROMPTS = 5
const MAX_EDITED = 40
const MAX_READ = 10
const MAX_ERRORS = 5
const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

export type NoteMeta = {
  /** Milliseconds since the epoch, when the note is written. */
  now: number
  /** What made it: a compaction trigger, or `checkpoint` for the command. */
  trigger: string
  cwd: string
  /** The project root; paths under it are written relative to it. */
  root?: string
  branch?: string
}

const slash = (p: string) => p.replace(/\\/g, '/')

export const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `yyyy-mm-dd HH:MM` in local time. */
export function stamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `<yyyy-mm-dd>-<HHmm>-<trigger>.md` */
export function noteName(ms: number, trigger: string): string {
  const [day, time] = stamp(ms).split(' ')
  return `${day}-${time.replace(':', '')}-${trigger.replace(/[^A-Za-z0-9_-]/g, '')}.md`
}

/** A prompt the person typed: not a tool result, a reminder, a command record or a compaction summary. */
function isTyped(m: SessionMessage): boolean {
  if (m.role !== 'user' || (m.toolResults?.length ?? 0) > 0) return false
  const t = m.text.trim()
  return t !== '' && !t.startsWith('<') && !t.startsWith('[Request interrupted') && !/^This session is being continued from a previous conversation/.test(t)
}

const pathOf = (input: Record<string, unknown>): string | undefined => {
  const p = input.file_path ?? input.notebook_path
  return typeof p === 'string' && p.trim() ? p.trim() : undefined
}

function relative(p: string, root?: string): string {
  const s = slash(p)
  if (!root) return s
  const r = slash(root).replace(/\/+$/, '')
  return s.toLowerCase().startsWith(r.toLowerCase() + '/') ? s.slice(r.length + 1) : s
}

type Todo = { content: string; status: string }

/** The todo list the last TodoWrite call set, or undefined when there was none. */
function lastTodos(messages: readonly SessionMessage[]): Todo[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const uses = messages[i].toolUses ?? []
    for (let j = uses.length - 1; j >= 0; j--) {
      if (uses[j].tool !== 'TodoWrite') continue
      const todos = (uses[j].input as { todos?: unknown }).todos
      if (!Array.isArray(todos)) continue
      return todos
        .filter(t => t && typeof t.content === 'string')
        .map(t => ({ content: String(t.content), status: typeof t.status === 'string' ? t.status : 'pending' }))
    }
  }
  return undefined
}

/** The handoff note, markdown. */
export function buildNote(messages: readonly SessionMessage[], meta: NoteMeta): string {
  const typed = messages.filter(isTyped).map(m => m.text)
  const uses = messages.flatMap(m => m.toolUses ?? [])

  const edited: string[] = []
  const read: string[] = []
  for (let i = uses.length - 1; i >= 0; i--) {
    const u = uses[i]
    const p = pathOf(u.input ?? {})
    if (!p) continue
    const rel = relative(p, meta.root)
    if (EDITS.has(u.tool) && edited.length < MAX_EDITED && !edited.includes(rel)) edited.push(rel)
    else if (u.tool === 'Read' && read.length < MAX_READ && !read.includes(rel)) read.push(rel)
  }

  const errors = uses
    .filter(u => u.isError)
    .slice(-MAX_ERRORS)
    .map(u => {
      const first = (u.text ?? '').split(/\r?\n/).find(l => l.trim()) ?? '(no error text)'
      return `- ${u.tool}: ${clip(first, ERROR_CHARS)}`
    })

  const todos = lastTodos(messages)
  const open = (todos ?? []).filter(t => t.status !== 'completed')

  const out: string[] = ['# Checkpoint handoff', '']
  out.push(`- Time: ${stamp(meta.now)}`, `- Trigger: ${meta.trigger}`, `- Cwd: ${slash(meta.cwd)}`)
  if (meta.branch) out.push(`- Branch: ${meta.branch}`)
  out.push('', '## Goal', '')
  if (typed.length === 0) out.push('(no typed prompts in this part of the session)')
  else {
    out.push('First prompt:', `> ${clip(typed[0], GOAL_CHARS)}`, '', 'Latest prompts (oldest first):')
    typed.slice(-RECENT_PROMPTS).forEach((t, i) => out.push(`${i + 1}. ${clip(t, GOAL_CHARS)}`))
  }
  out.push('', '## Open tasks', '')
  if (todos === undefined) out.push('(no todo list in this part of the session)')
  else if (open.length === 0) out.push('(all todos completed)')
  else open.forEach(t => out.push(`- [ ] ${t.status === 'in_progress' ? '(in progress) ' : ''}${clip(t.content, GOAL_CHARS)}`))
  out.push('', '## Files touched', '')
  if (edited.length === 0 && read.length === 0) out.push('(none)')
  if (edited.length > 0) out.push('Edited (most recent first):', ...edited.map(p => `- ${p}`))
  if (read.length > 0) out.push(...(edited.length > 0 ? [''] : []), 'Read recently:', ...read.map(p => `- ${p}`))
  out.push('', '## Recent errors', '')
  out.push(...(errors.length > 0 ? errors : ['(none)']))
  return out.join('\n') + '\n'
}

/** How many `- [ ]` items the note's Open tasks section lists. */
export function openTaskCount(note: string): number {
  const at = note.indexOf('## Open tasks')
  if (at === -1) return 0
  const rest = note.slice(at + '## Open tasks'.length)
  const end = rest.search(/\n## /)
  return (end === -1 ? rest : rest.slice(0, end)).split(/\r?\n/).filter(l => l.startsWith('- [ ]')).length
}

/** The summarizer's instructions: what it was told, plus the keep-these-facts block. */
export function keepInstructions(existing: string | undefined, notePath: string): string {
  const block =
    'Preserve verbatim in the summary: open tasks, the file paths being worked on, the last errors and decisions. ' +
    `A full handoff note was saved at ${notePath} (in the project root).`
  return existing && existing.trim() ? `${existing.trim()}\n\n${block}` : block
}

/** The branch a `.git/HEAD` names, or a short commit when detached. */
export function branchOf(head: string): string | undefined {
  const t = head.trim()
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(t)
  if (ref) return ref[1]
  return /^[0-9a-f]{40}$/i.test(t) ? `detached at ${t.slice(0, 7)}` : undefined
}

/** `5 minutes ago`, `3 hours ago`, `2 days ago`. */
export function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}
