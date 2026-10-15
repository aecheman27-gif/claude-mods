import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ShellWindow } from '../types'

// Before Edit/Write/NotebookEdit, a shell command that writes, or an MCP tool that writes a file, asks when
// the file changed in the last few minutes by something other than this chat: Gemini or another agent on a
// shared folder, an editor, a sync. Built-in Edit already refuses a file that changed since Claude read it;
// this also covers a file Claude never read, and asks before Claude starts building on a half-finished
// outside edit. A Cancel sticks to that outside version until the person says Edit anyway or it ages out.
// $.fs.stat, $.clock and $.ui.ask only: no network, processes or model calls.

const seen = atom({ plugin: 'shared-edit-guard', key: 'seen' } as const, {})
const refused = atom({ plugin: 'shared-edit-guard', key: 'refused' } as const, {})
const shells = atom({ plugin: 'shared-edit-guard', key: 'shells' } as const, [])

const SLACK_MS = 2000
const SEEN_MAX = 500
const COMMAND_MAX = 2000
const NAMED_MAX = 20
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

// Does the command look like it changes files: a redirect, PowerShell's writers, an in-place editor, a copy,
// move or delete, a formatter or fixer, a one-liner that opens a file for writing?
const WRITES = new RegExp(
  [
    String.raw`(?:^|[^\d&>=-])>{1,2}(?!\s*(?:&|/dev/null|\$null\b|nul\b))`,
    String.raw`\b(?:Set-Content|Add-Content|Out-File|Clear-Content|Tee-Object|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Export-Csv|Export-Clixml|WriteAll(?:Text|Lines|Bytes)|AppendAll(?:Text|Lines))\b`,
    String.raw`\b(?:sed|perl)\b[^|;&]*\s(?:-\w*i\b|--in-place)`,
    String.raw`\b(?:tee|cp|mv|rm|del|copy|move|ren|truncate|touch|patch|dd)\b`,
    String.raw`\bgit\s+(?:checkout|restore|apply|stash|reset|mv|rm)\b`,
    String.raw`\b(?:black|isort|autopep8|yapf|gofmt|rustfmt|clang-format)\b|\bdotnet\s+format\b|\bruff\s+format\b`,
    String.raw`\b(?:prettier|eslint|ruff)\b[^|;&]*\s--(?:write|fix)\b`,
    String.raw`\bopen\([^)]*['"][wax]\+?['"]|\.write(?:_text|_bytes)?\(|\b(?:writeFileSync|appendFileSync)\b`,
  ].join('|'),
  'i',
)
export const writes = (command: string) => WRITES.test(command)

// The files a command names: quoted paths whole (they may hold spaces), and path-looking words with an extension.
export const named = (command: string) => {
  const quoted: string[] = []
  const rest = command.replace(/"([^"]+)"|'([^']+)'/g, (all: string, a?: string, b?: string) => {
    const s = a ?? b ?? ''
    if (!/^(?:[A-Za-z]:)?[^*?<>|:]*\.\w{1,10}$/.test(s)) return all
    quoted.push(s)
    return ' '
  })
  const words = rest.match(/(?:[A-Za-z]:)?(?:[\w.~-]*[\\/])*[\w.-]*\w\.\w{1,10}(?![\w\\/])/g) ?? []
  return [...new Set([...quoted, ...words])].filter(p => !/^\w+:\/\//.test(p)).slice(0, NAMED_MAX)
}

// Parallel agents keep some shell running almost all the time, so a window only covers changes its own
// command could have made: to files it names, and only when it looks like it writes (a 9-minute run that
// reads a config does not make an outside edit to that config its own).
export const byOwnShell = (m: number, path: string, windows: readonly ShellWindow[]) =>
  windows.some(w => m >= w.from - SLACK_MS && m <= w.to + SLACK_MS && writes(w.command ?? '') && names(w.command ?? '', path))

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`)
const short = (p: string) => p.replace(/\\/g, '/').split('/').slice(-2).join('/')

// Asks when the file changed outside this chat within the window; answers the deny text, or undefined to go
// on. A Cancel is kept for that outside version, so reading the file does not turn the next change into a
// silent one: it asks again until the person says Edit anyway or the change ages out of the window.
async function check($: EngineInterface, path: string, windowMs: number): Promise<string | undefined> {
  const m = await mtime($, path)
  if (m === undefined) return undefined
  const now = await $.clock.now()
  const key = keyOf(path)
  if (now - m >= windowMs) return undefined
  const isRefused = (await read($, refused))[key] === m
  if (!isRefused && ((await read($, seen))[key] === m || byOwnShell(m, path, await read($, shells)))) return undefined
  let answer: string
  try {
    answer = await $.ui.ask(`${short(path)} was changed outside this chat ${ago(now - m)} ago (Gemini or another tool?). Edit it anyway?`, ASK_OPTIONS)
  } catch {
    answer = ''
  }
  if (answer === 'Edit anyway') {
    await update($, refused, all => Object.fromEntries(Object.entries(all).filter(([k]) => k !== key)))
    return undefined
  }
  await update($, refused, all => remembered(all, key, m, now - windowMs))
  return `shared-edit-guard: ${path} was changed outside this chat ${ago(now - m)} ago and the user did not approve changing it. Do not retry, and do not change it another way (a shell command such as Set-Content, Out-File, sed -i or a redirect, a script, or another tool): tell the user what you meant to change and wait for them. Reading the file is fine; the next change asks again.`
}

// MCP tools whose name says they write, and the path-looking arguments they write to.
const MCP_WRITES = /write|edit|create|update|move|rename|delete|remove|append|patch|save|replace|insert/i
export const mcpPaths = (tool: string, input: Record<string, unknown>) =>
  tool.startsWith('mcp__') && MCP_WRITES.test(tool.split('__').slice(2).join('__'))
    ? Object.entries(input)
        .filter(([k, v]) => /path|file|dest|target|source/i.test(k) && typeof v === 'string' && /[\\/]|\.\w{1,10}$/.test(v))
        .map(([, v]) => v as string)
    : []

export const register: Register = (on, options) => {
  const windowMs = Math.max(1, Number(options.windowMinutes ?? 10)) * 60_000

  // Gate: judge before next, so the .catch below can refuse on any failure.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    const deny = await check($, path, windowMs)
    if (deny) return { deny }
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

  // A shell command that looks like it writes asks first about the files it names. Changes made while one
  // ran, to files it names, are its own.
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const command = String(e.command ?? '').slice(0, COMMAND_MAX)
    if (writes(command)) {
      for (const path of named(command)) {
        const deny = await check($, path, windowMs)
        if (deny) return { deny }
      }
    }
    const from = await $.clock.now()
    const ran = await next(e)
    const to = await $.clock.now()
    await update($, shells, list => [...list, { from, to, command }].filter(w => to - w.to < 24 * 60 * 60_000).slice(-200)).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

  // MCP tools that write a file (a filesystem server's write_file, edit_file, move_file) ask the same way.
  on('tool.call', async ($, e, next) => {
    const paths = mcpPaths(String(e.tool), e as Record<string, unknown>)
    if (paths.length === 0) return next(e)
    for (const path of paths) {
      const deny = await check($, path, windowMs)
      if (deny) return { deny }
    }
    const ran = await next(e)
    if (!ran.deny && !ran.isError) for (const path of paths) await remember($, path, windowMs).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))
}
