import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { parseLog, parseNumstat, parseStatus } from './git'

// Captured from a real repo (git 2.55): a staged delete, a file changed both
// staged and unstaged, a staged rename with spaces, two untracked files.
const STATUS = [
  '# branch.oid eb5ff3cf0b3232edcae5a30d3d9c7fb2889e0409',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
  '1 D. N... 100644 000000 000000 286c5f5776916d7d7d5849988ca9d83e722cf9c2 0000000000000000000000000000000000000000 gone.txt',
  '1 MM N... 100644 100644 100644 422c2b7ab3b3c668038da977e4e93a5fc623169c 7be73ce3c1b1cdaea86e8168dfee8575175953bf keep.txt',
  '2 R. N... 100644 100644 100644 587be6b4c3f93f93c489c0111bba5596147a26cb 587be6b4c3f93f93c489c0111bba5596147a26cb R100 new name.txt',
  'old name.txt',
  'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc both.txt',
  '? new file.md',
  '',
].join('\0')
const UNSTAGED = '1\t0\tkeep.txt\0'
const STAGED = '0\t1\tgone.txt\x002\t1\tkeep.txt\x001\t0\tnew name.txt\x000\t1\told name.txt\0'
const LOG = 'eb5ff3c\x1ffirst commit\x1f2 hours ago\n'

type Opts = { isOpen?: boolean; isRepo?: boolean; stored?: Record<string, unknown>; statusMs?: number }

function world(on: On, opts: Opts = {}) {
  const clock = mock.clock(on, { now: 1000 })
  const w = { clock, runs: [] as string[][], opened: [] as string[], closed: [] as string[], stored: { ...(opts.stored ?? {}) } as Record<string, unknown>, isOpen: opts.isOpen ?? false, statuses: 0, statusesNow: 0, statusesAtOnce: 0 }

  on('session.start', async () => ({ cwd: 'C:/work/app' }) as never)
  on('session.cwd', async () => ({ value: 'C:\\work\\app' }) as never)
  on('command.register', async ($, e) => ({ value: { command: e.name } }) as never)
  on('store.get', async ($, e) => ({ value: w.stored[e.key] }) as never)
  on('store.set', async ($, e) => {
    w.stored[e.key] = e.value
    return { value: undefined } as never
  })
  on('ui.panes', async () => ({ value: w.isOpen ? [{ id: 'changes', title: 'Changes', isPlaced: true }] : [] }) as never)
  on('ui.open', async ($, e) => {
    w.opened.push(e.id)
    w.isOpen = true
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', async ($, e) => {
    w.closed.push(e.id)
    w.isOpen = false
    return { value: undefined } as never
  })
  on('process.run', async ($, e) => {
    const argv = e.argv as string[]
    w.runs.push(argv)
    const sub = argv.slice(4).join(' ')
    if (opts.isRepo === false) return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n', isStdoutTruncated: false, isStderrTruncated: false } } as never
    if (sub.startsWith('status') && opts.statusMs) {
      w.statuses++
      w.statusesAtOnce = Math.max(w.statusesAtOnce, ++w.statusesNow)
      await clock.sleep(opts.statusMs)
      w.statusesNow--
    }
    const stdout = sub.startsWith('status') ? STATUS : sub.startsWith('diff --cached') ? STAGED : sub.startsWith('diff') ? UNSTAGED : sub.startsWith('log') ? LOG : 'stash@{0}: WIP\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('tool.call', async () => ({ result: {}, text: 'ok' }) as never)
  on('turn.complete', async ($, e) => e as never)
  return w
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/work/app', surface: 'terminal', isInteractive: true } as never)
const pane: RenderPropsOf['Pane'] = { title: 'Changes', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never
const textOf = async (ui: { findAll: (q: object) => Promise<{ text: string }[]> }) => (await ui.findAll({}))[0]?.text ?? ''
const mount = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'git-changes', surface, component: 'Pane', props: pane, requestId: 'changes' } as never)

describe('pane', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: /changes opens it and lists every kind of change`, async ($, on) => {
      const w = world(on)
      await start($)
      const r = await $.command.run({ command: 'changes', args: '' } as never)
      expect(JSON.stringify(r)).toContain('opened')
      expect(w.opened).toEqual(['changes'])
      expect(w.stored.open).toBe(true)
      const text = await textOf(await mount($, surface))
      expect(text).toContain('⎇ main → origin/main ↑2 ↓1 · 1 stash')
      expect(text).toContain('Conflicts (1)')
      expect(text).toContain('U both.txt')
      expect(text).toContain('Staged (3)')
      expect(text).toContain('M keep.txt +2 -1')
      expect(text).toContain('R old name.txt → new name.txt +1 -0')
      expect(text).toContain('D gone.txt +0 -1')
      expect(text).toContain('Changes (1)')
      expect(text).toContain('M keep.txt +1 -0')
      expect(text).toContain('Untracked (1)')
      expect(text).toContain('? new file.md')
      expect(text).toContain('eb5ff3c first commit 2 hours ago')
    })
  }

  test('only read-only git commands run, in the session directory', async ($, on) => {
    const w = world(on)
    await start($)
    await $.command.run({ command: 'changes', args: '' } as never)
    const subcommands = w.runs.map(a => a.slice(4, 6).join(' '))
    expect(w.runs.every(a => a[0] === 'git' && a[1] === '--no-optional-locks' && a[2] === '-C' && a[3] === 'C:\\work\\app')).toBe(true)
    expect(subcommands.sort()).toEqual(['diff --cached', 'diff --numstat', 'log -5', 'stash list', 'status --porcelain=v2'])
  })

  test('outside a repo it says so', async ($, on) => {
    world(on, { isRepo: false })
    await start($)
    await $.command.run({ command: 'changes', args: '' } as never)
    expect(await textOf(await mount($))).toContain('Not a git repository: C:\\work\\app')
  })

  test('/changes again closes it and remembers', async ($, on) => {
    const w = world(on)
    await start($)
    await $.command.run({ command: 'changes', args: '' } as never)
    const r = await $.command.run({ command: 'changes', args: '' } as never)
    expect(JSON.stringify(r)).toContain('closed')
    expect(w.closed).toEqual(['changes'])
    expect(w.stored.open).toBe(false)
  })

  test('reopens at start when it was open last time', async ($, on) => {
    const w = world(on, { stored: { open: true } })
    await start($)
    await w.clock.advance(10)
    expect(w.opened).toEqual(['changes'])
  })

  test('an edit refreshes it once the burst settles, and only while open', async ($, on) => {
    const w = world(on)
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: 'C:/work/app/a.ts', old_string: 'a', new_string: 'b' } as never)
    await w.clock.advance(1000)
    expect(w.runs.length).toBe(0) // closed: no git at all
    await $.command.run({ command: 'changes', args: '' } as never)
    const before = w.runs.length
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    await $.tool.call({ tool: 'Write', file_path: 'C:/work/app/b.ts', content: 'x' } as never)
    expect(w.runs.length).toBe(before)
    await w.clock.advance(1000)
    expect(w.runs.length).toBe(before * 2) // one more look, not two
  })

  test('a slow git status never overlaps: calls during a look earn exactly one more', async ($, on) => {
    const w = world(on, { isOpen: true, statusMs: 5000 })
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: 'C:/work/app/a.ts', old_string: 'a', new_string: 'b' } as never)
    await w.clock.advance(1000)
    expect(w.statuses).toBe(1) // the first look is under way, its status still running
    for (const command of ['npm test', 'npm run lint', 'npm run build']) {
      await $.tool.call({ tool: 'Bash', command } as never)
      await w.clock.advance(1000)
    }
    expect(w.statuses).toBe(1) // no second look while the first runs
    await w.clock.advance(20_000)
    expect(w.statuses).toBe(2) // exactly one trailing look
    expect(w.statusesAtOnce).toBe(1)
    await w.clock.advance(20_000)
    expect(w.statuses).toBe(2)
  })
})

describe('git', () => {
  test('parsers', async () => {
    const s = parseStatus(STATUS)
    expect(s.staged.map(f => f.path)).toEqual(['gone.txt', 'keep.txt', 'new name.txt'])
    expect(s.staged[2].from).toBe('old name.txt')
    expect(s.unstaged).toEqual([{ path: 'keep.txt', code: 'M' }])
    expect(s.untracked).toEqual(['new file.md'])
    expect(s.conflicts).toEqual(['both.txt'])
    expect(parseStatus('# branch.oid (initial)\0# branch.head main\0').branch).toBe('main')
    expect(parseStatus('# branch.head (detached)\0').branch).toBe('detached HEAD')
    expect(parseNumstat('-\t-\timg.png\x003\t4\ta b.txt\0')).toEqual(
      new Map([
        ['img.png', { isBinary: true }],
        ['a b.txt', { added: 3, removed: 4 }],
      ]),
    )
    expect(parseLog(LOG)).toEqual([{ hash: 'eb5ff3c', subject: 'first commit', when: '2 hours ago' }])
  })
})
