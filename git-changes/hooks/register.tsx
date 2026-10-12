import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileChange, Snapshot, Status } from '../types'
import { parseLog, parseNumstat, parseStatus, withCounts } from './git'

// A /changes pane: the branch and how far it is from its upstream, what is
// staged, changed, untracked and conflicted (with +/- line counts), and the
// last few commits. Read-only: it runs `git status`, `git diff --numstat`,
// `git log` and `git stash list` in the session's directory, only while the
// pane is open, after Claude edits files or runs a shell command, and at the
// end of each turn. No network, no model calls, nothing that writes.

const PANE = 'changes'
const STORE_OPEN = 'open'
const SHOW = 25
const snapshot = atom({ plugin: 'git-changes', key: 'snapshot' } as const, null)

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string> {
  const run = await $.process.run(['git', '--no-optional-locks', '-C', cwd, ...args], { timeoutMs: 8_000, env: { GIT_OPTIONAL_LOCKS: '0' } })
  if (run.exitCode !== 0) throw new Error(run.stderr.trim().split(/\r?\n/)[0] || `git ${args[0]} failed`)
  return run.stdout
}

async function look($: EngineInterface): Promise<Snapshot> {
  const cwd = await $.session.cwd()
  const at = await $.clock.now()
  let raw: string
  try {
    raw = await git($, cwd, ['status', '--porcelain=v2', '--branch', '-z'])
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return { status: null, problem: /not a git repository/i.test(why) ? `Not a git repository: ${cwd}` : `git: ${why}`, at }
  }
  const base = parseStatus(raw)
  const hasCommits = !raw.includes('# branch.oid (initial)')
  const [unstagedN, stagedN, log, stash] = await Promise.all([
    git($, cwd, ['diff', '--numstat', '-z', '--no-renames']).catch(() => ''),
    git($, cwd, ['diff', '--cached', '--numstat', '-z', '--no-renames']).catch(() => ''),
    hasCommits ? git($, cwd, ['log', '-5', '--format=%h%x1f%s%x1f%cr']).catch(() => '') : Promise.resolve(''),
    git($, cwd, ['stash', 'list']).catch(() => ''),
  ])
  const status: Status = {
    ...base,
    staged: withCounts(base.staged, parseNumstat(stagedN)),
    unstaged: withCounts(base.unstaged, parseNumstat(unstagedN)),
    commits: parseLog(log),
    stashes: stash.split(/\r?\n/).filter(Boolean).length,
  }
  return { status, problem: null, at }
}

const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

async function refresh($: EngineInterface) {
  const snap = await look($)
  await update($, snapshot, () => snap)
}

async function refreshIfOpen($: EngineInterface) {
  if (await isOpen($)) await refresh($)
}

// Edits and shell commands come in bursts: one look after the burst settles.
// Never two looks at once: calls that land while one runs (a slow `git status`
// in a big repo) earn exactly one more look after it.
let isQueued = false
let isRunning = false
let isStale = false
function soon($: EngineInterface) {
  if (isRunning) {
    isStale = true
    return
  }
  if (isQueued) return
  isQueued = true
  $.clock.after(800, () => void settle($))
}

async function settle($: EngineInterface) {
  isRunning = true
  try {
    do {
      isStale = false
      await refreshIfOpen($).catch(() => undefined)
    } while (isStale)
  } finally {
    isRunning = false
    isQueued = false
  }
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Changes' })
  await refresh($).catch(err => update($, snapshot, () => ({ status: null, problem: String(err), at: 0 })))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'changes', description: 'Show or hide the git changes pane (staged, unstaged, untracked, ahead/behind, recent commits)' })
    const ran = await next(e)
    if ((await $.store.get(STORE_OPEN).catch(() => false)) === true) void openPane($).catch(() => undefined)
    return ran
  })

  on('command.run', { command: 'changes' }, async $ => {
    if (await isOpen($)) {
      await $.ui.close({ id: PANE })
      await $.store.set(STORE_OPEN, false)
      return { text: 'Changes pane closed.' }
    }
    await openPane($)
    await $.store.set(STORE_OPEN, true)
    return { text: 'Changes pane opened.' }
  })

  on('tool.call', { tool: ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const ran = await next(e)
    soon($)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    soon($)
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const width = e.props.bodyColumns
    const s = snap?.status

    const fileRow = (f: FileChange, color: string) => {
      const name = f.from ? `${f.from} → ${f.path}` : f.path
      const room = Math.max(10, width - 18) // the counts keep their place; a long path loses its head
      return (
        <Text wrap="truncate-end">
          {'  '}
          <Text color={f.code === 'D' ? '#f87171' : color}>{f.code} </Text>
          {name.length > room ? '…' + name.slice(name.length - room + 1) : name}
          {f.isBinary ? (
            <Text dimColor> bin</Text>
          ) : f.added !== undefined ? (
            <Text>
              {' '}
              <Text color="#4ade80">+{f.added}</Text> <Text color="#f87171">-{f.removed}</Text>
            </Text>
          ) : null}
        </Text>
      )
    }
    const section = (title: string, color: string, files: FileChange[]) =>
      files.length === 0 ? null : (
        <Box flexDirection="column">
          <Text bold color={color}>
            {title} ({files.length})
          </Text>
          {files.slice(0, SHOW).map(f => fileRow(f, color))}
          {files.length > SHOW && <Text dimColor>  +{files.length - SHOW} more</Text>}
        </Box>
      )
    const paths = (list: string[], code: string) => list.map(path => ({ path, code }))

    return (
      <Box flexDirection="column" width={width}>
        {!snap && <Text dimColor>Looking…</Text>}
        {snap?.problem && <Text color="#facc15">{snap.problem}</Text>}
        {s && (
          <Text wrap="truncate-end">
            <Text bold color="#22d3ee">
              ⎇ {s.branch}
            </Text>
            {s.upstream ? (
              <Text>
                {' '}
                → {s.upstream} <Text color={s.ahead ? '#4ade80' : 'gray'}>↑{s.ahead}</Text> <Text color={s.behind ? '#facc15' : 'gray'}>↓{s.behind}</Text>
              </Text>
            ) : (
              <Text dimColor> (no upstream)</Text>
            )}
            {s.stashes > 0 && <Text dimColor> · {s.stashes} stash{s.stashes === 1 ? '' : 'es'}</Text>}
          </Text>
        )}
        {s && s.staged.length + s.unstaged.length + s.untracked.length + s.conflicts.length === 0 && <Text color="#4ade80">Working tree clean.</Text>}
        {s && section('Conflicts', '#f87171', paths(s.conflicts, 'U'))}
        {s && section('Staged', '#4ade80', s.staged)}
        {s && section('Changes', '#facc15', s.unstaged)}
        {s && section('Untracked', 'gray', paths(s.untracked, '?'))}
        {s && s.commits.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Recent commits</Text>
            {s.commits.map(c => (
              <Text wrap="truncate-end">
                {'  '}
                <Text color="#a78bfa">{c.hash}</Text> {c.subject} <Text dimColor>{c.when}</Text>
              </Text>
            ))}
          </Box>
        )}
        <Text> </Text>
        <Button key="refresh" label="Refresh" onPress={() => void refresh($).catch(() => undefined)} />
      </Box>
    )
  })
}
