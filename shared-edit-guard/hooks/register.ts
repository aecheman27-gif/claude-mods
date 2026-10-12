import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ShellWindow } from '../types'

// Before Edit/Write/NotebookEdit, asks when the file changed in the last few
// minutes by something other than this chat: Gemini or another agent on a
// shared folder, an editor, a sync. Built-in Edit already refuses a file that
// changed since Claude read it; this also covers a file Claude never read, and
// asks before Claude starts building on a half-finished outside edit.
// $.fs.stat and $.clock only: no network, processes or model calls.

const seen = atom({ plugin: 'shared-edit-guard', key: 'seen' } as const, {})
const shells = atom({ plugin: 'shared-edit-guard', key: 'shells' } as const, [])

const SLACK_MS = 2000
const SEEN_MAX = 500
const COMMAND_MAX = 2000
const ASK_OPTIONS = { options: ['Cancel', 'Edit anyway'], header: 'Shared file' } as const

// Windows paths (drive letter or backslashes) compare case-insensitively.
const isWin = (p: string) => /^[A-Za-z]:|\\/.test(p)
export const keyOf = (p: string) => (isWin(p) ? p.replace(/\\/g, '/').toLowerCase() : p)

async function mtime($: EngineInterface, path: string): Promise<number | undefined> {
  try {
    const s = await $.fs.stat(path)
    return s.kind === 'file' ? s.mtimeMs : undefined
  } catch {
    return undefined // no such file yet
  }
}

// Versions older than the window can never cause a prompt, so they are dropped; the rest are capped.
export const remembered = (all: Record<string, number>, key: string, m: number, cutoff: number) =>
  Object.fromEntries(
    Object.entries({ ...all, [key]: m })
      .filter(([, t]) => t > cutoff)
      .sort((a, b) => b[1] - a[1])
      .slice(0, SEEN_MAX),
  )

async function remember($: EngineInterface, path: string, windowMs: number) {
  const m = await mtime($, path)
  if (m === undefined) return
  const cutoff = (await $.clock.now()) - windowMs
  await update($, seen, all => remembered(all, keyOf(path), m, cutoff))
}

// Does the command name this file (its basename as a whole word, so also any path ending in it)?
const names = (command: string, path: string) => {
  const fold = (s: string) => (isWin(path) ? s.toLowerCase() : s)
  const base = fold(path.split(/[\\/]/).pop() ?? '')
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return base !== '' && new RegExp(`(^|[^\\w.-])${esc}($|[^\\w.-])`).test(fold(command))
}

// Parallel agents keep some shell running almost all the time, so a window only
// covers changes to files its own command names.
export const byOwnShell = (m: number, path: string, windows: readonly ShellWindow[]) =>
  windows.some(w => m >= w.from - SLACK_MS && m <= w.to + SLACK_MS && names(w.command ?? '', path))

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`)
const short = (p: string) => p.replace(/\\/g, '/').split('/').slice(-2).join('/')

export const register: Register = (on, options) => {
  const windowMs = Math.max(1, Number(options.windowMinutes ?? 10)) * 60_000

  // Gate: judge before next, so the .catch below can refuse on any failure.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    const m = await mtime($, path)
    if (m !== undefined) {
      const now = await $.clock.now()
      const known = (await read($, seen))[keyOf(path)]
      const isRecent = now - m < windowMs
      if (isRecent && known !== m && !byOwnShell(m, path, await read($, shells))) {
        let answer: string
        try {
          answer = await $.ui.ask(`${short(path)} was changed outside this chat ${ago(now - m)} ago (Gemini or another tool?). Edit it anyway?`, ASK_OPTIONS)
        } catch {
          answer = ''
        }
        if (answer !== 'Edit anyway') {
          return {
            deny: `shared-edit-guard: ${path} was changed outside this chat ${ago(now - m)} ago and the user did not approve editing it. Re-read the file and check with the user before changing it.`,
          }
        }
      }
    }
    const ran = await next(e)
    if (!ran.deny && !ran.isError) await remember($, path, windowMs)
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'shared-edit-guard: the shared-file check failed, so the edit was blocked.' }))

  // Ledger: the version Claude read is one it knows.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.deny && !ran.isError) await remember($, e.file_path, windowMs).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

  // Changes made while this chat's own shell command ran, to files it names, are its own.
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const from = await $.clock.now()
    const ran = await next(e)
    const to = await $.clock.now()
    const command = String(e.command ?? '').slice(0, COMMAND_MAX)
    await update($, shells, list => [...list, { from, to, command }].filter(w => to - w.to < 24 * 60 * 60_000).slice(-200)).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))
}
