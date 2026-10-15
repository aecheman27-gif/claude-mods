// my-claude-mods: what is held (Monitor, wrappers, substitutions, bundled
// flags), how it is measured (Git Bash on Windows, never "delete nothing" from
// a bash that failed), and that every failure while holding refuses the call.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

declare const setTimeout: (fn: (...args: never[]) => void, ms: number) => unknown // the test runner's; the API types declare no timers

const tick = () => new Promise(r => setTimeout(r, 5))
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const pane: RenderPropsOf['Pane'] = { title: 'Blast Radius', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as never

type Ran = { exitCode: number; stdout: string; stderr: string }
type Opts = { env?: Record<string, string>; exists?: string[]; run?: (argv: string[]) => Ran | undefined; failPolls?: () => boolean }

function world(on: On, opts: Opts = {}) {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, opts.env ?? {})
  const w = { runs: [] as string[][], opened: 0, ran: [] as string[], clock }
  const isPoll = (argv: string[]) => argv[0] === 'sleep' || argv.at(-1)?.startsWith('sleep ') === true
  on('session.cwd', async () => ({ value: 'C:\\work\\app' }) as never)
  on('fs.exists', async ($, e) => ({ value: (opts.exists ?? []).includes(e.path) }) as never)
  on('process.run', async ($, e) => {
    const argv = [...(e.argv as string[])]
    w.runs.push(argv)
    if (isPoll(argv)) {
      if (opts.failPolls?.()) throw new Error('spawn sleep ENOENT')
      await tick() // the hold's poll: let the test act
    }
    const out = opts.run?.(argv) ?? { exitCode: 0, stdout: '', stderr: '' }
    return { value: { ...out, isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('ui.open', async () => {
    w.opened += 1
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('tool.call', async ($, e) => {
    w.ran.push(String((e as { command?: string }).command))
    return { result: {}, text: 'ran' } as never
  })
  return w
}

/** Calls the tool; when a pane opens, reads it and presses Cancel. Resolves the pane's text, or null when nothing was held. */
async function hold($: Engine, w: ReturnType<typeof world>, command: string, tool = 'Bash') {
  const before = w.opened
  let isDone = false
  const input = tool === 'Monitor' ? { tool, command, description: 'watch', timeout_ms: 60000 } : { tool, command }
  const call = $.tool.call(input as never).then(r => {
    isDone = true
    return r
  })
  for (let i = 0; i < 400 && !isDone && w.opened === before; i++) await tick()
  if (w.opened === before) {
    await call
    return null
  }
  const ui = await $.ui.mount({ plugin: 'blast-radius', surface: 'terminal', component: 'Pane', requestId: 'blast-radius', props: pane } as never)
  const text = (await ui.findAll({}))[0]?.text ?? ''
  await ui.press({ key: 'cancel' })
  await w.clock.advance(1000) // a hold polling on the clock (no Git Bash) wakes and sees the answer
  expect(JSON.stringify(await call)).toContain('Blast Radius held this command and did not run it')
  await ui.unmount()
  return text
}

describe('what is held', () => {
  test('Monitor runs a shell command too: rm -rf through it is held', async ($, on) => {
    const w = world(on)
    expect(await hold($, w, 'rm -rf build', 'Monitor')).toContain('Blast Radius')
    expect(await hold($, w, 'tail -f build.log', 'Monitor')).toBe(null)
    expect(w.ran).toEqual(['tail -f build.log'])
  })

  test('separators, substitutions, xargs, find and wrappers', async ($, on) => {
    const w = world(on)
    const risky = [
      'make clean & rm -rf build',
      'x=$(rm -rf build)',
      'echo `rm -rf build`',
      'echo "$(cd sub; rm -rf build)"',
      "find . -name '*.o' | xargs rm -rf",
      'find build -type f | xargs -n 10 -P 4 rm -f',
      'find build -delete',
      "find . -name '*.pyc' -exec rm {} \\;",
      'timeout 5 rm -rf build',
      'timeout -s KILL 30s rm -rf build',
      'bash -c "rm -rf build"',
      "sh -c 'cd sub && rm -rf build'",
      'bash -lc "git reset --hard"',
      'env -i rm -rf build',
      'env FOO=1 rm -rf build',
      'nohup sudo rm -rf build',
      'sudo -u root nice -n 5 rm -rf build',
      'eval "rm -rf build"',
      'git push -fu origin main',
      'git push origin main -vf',
    ]
    for (const command of risky) {
      expect({ command, held: (await hold($, w, command)) !== null }).toEqual({ command, held: true })
    }
    const harmless = [
      'make clean & echo done',
      'ls -la 2>&1 | grep build',
      'make >& build.log',
      'echo hi &> log',
      'x=$(ls build)',
      "find . -name '*.o' -print",
      'find . | xargs grep TODO',
      'timeout 5 make test',
      'bash -c "echo hi"',
      'git push -u origin main',
      'git push -o ci.skip origin main',
    ]
    for (const command of harmless) {
      expect({ command, held: (await hold($, w, command)) !== null }).toEqual({ command, held: false })
    }
    expect(w.ran).toEqual(harmless)
  })

  test('paths the shell decides are not measured as text', async ($, on) => {
    const w = world(on)
    for (const command of ['rm -rf $(cat list.txt)', 'rm -rf "$BUILD_DIR"', "find . -name '*.o' | xargs rm -rf", 'find build -delete']) {
      const text = await hold($, w, command)
      expect(text).toContain('could not measure')
      expect(text).not.toContain('delete nothing')
    }
    // nothing was run to measure them
    expect(w.runs.filter(a => a.includes('blast-radius'))).toEqual([])
  })
})

describe('measuring', () => {
  test('a bash that fails or prints an error is "could not measure", never "delete nothing"', async ($, on) => {
    const answers: Ran[] = [
      { exitCode: 127, stdout: '', stderr: 'bash: line 1: compgen: command not found' },
      { exitCode: 0, stdout: 'Windows Subsystem for Linux has no installed distributions.\n', stderr: '' },
      { exitCode: 1, stdout: '0 0 0\n', stderr: '' },
    ]
    let next: Ran | undefined
    const w = world(on, { run: argv => (argv[0] === 'bash' && argv[1] === '-c' ? next : undefined) })
    for (const answer of answers) {
      next = answer
      const text = await hold($, w, 'rm -rf build')
      expect(text).toContain('could not measure')
      expect(text).not.toContain('delete nothing')
      expect(text).not.toContain('NaN')
    }
    next = { exitCode: 0, stdout: '0 0 0\n', stderr: '' }
    expect(await hold($, w, 'rm -rf build')).toContain('delete nothing')
  })

  test('on Windows it measures and waits in Git Bash by path, never the bash or sleep on PATH', async ($, on) => {
    const w = world(on, {
      env: { OS: 'Windows_NT', ProgramFiles: 'C:\\Program Files' },
      exists: [GIT_BASH],
      run: argv => (argv[0] === GIT_BASH && argv[2]?.includes('compgen') ? { exitCode: 0, stdout: '2 2048 1\n./build/a.o\n./build/b.o\n', stderr: '' } : undefined),
    })
    const text = await hold($, w, 'rm -rf build')
    expect(text).toContain('delete 2 files')
    expect(w.runs.some(a => a[0] === GIT_BASH && a[1] === '-c' && a[2] === 'sleep 0.25')).toBe(true)
    expect(w.runs.filter(a => a[0] === 'bash' || a[0] === 'sleep')).toEqual([])
  })

  test('CLAUDE_CODE_GIT_BASH_PATH wins over the default install', async ($, on) => {
    const custom = 'D:\\tools\\git\\bin\\bash.exe'
    const w = world(on, { env: { OS: 'Windows_NT', CLAUDE_CODE_GIT_BASH_PATH: custom, ProgramFiles: 'C:\\Program Files' }, exists: [custom, GIT_BASH] })
    await hold($, w, 'rm -rf build')
    expect(w.runs.some(a => a[0] === custom && a[2]?.includes('compgen'))).toBe(true)
    expect(w.runs.some(a => a[0] === GIT_BASH)).toBe(false)
  })

  test('Windows with no Git Bash: "could not measure", the hold waits on the clock, and no WSL bash or sleep is run', async ($, on) => {
    const w = world(on, { env: { OS: 'Windows_NT', ProgramFiles: 'C:\\Program Files' }, run: argv => (argv[0] === 'git' ? { exitCode: 1, stdout: '', stderr: '' } : undefined) })
    const text = await hold($, w, 'rm -rf build')
    expect(text).toContain('Git Bash was not found')
    expect(w.runs.filter(a => a[0] === 'bash' || a[0] === 'sleep')).toEqual([])
  })
})

describe('failing closed', () => {
  test('a poll that cannot run refuses the held call and the one waiting behind it', async ($, on) => {
    let isBroken = false
    const w = world(on, { failPolls: () => isBroken })
    const first = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as never)
    for (let i = 0; i < 400 && w.opened === 0; i++) await tick()
    expect(w.opened).toBe(1)
    const second = $.tool.call({ tool: 'Bash', command: 'git reset --hard' } as never)
    for (let i = 0; i < 10; i++) await tick() // the second waits behind the first
    isBroken = true
    const [a, b] = [JSON.stringify(await first), JSON.stringify(await second)]
    expect(a).toContain('Blast Radius')
    expect(b).toContain('Blast Radius')
    expect(w.ran).toEqual([])
  })

  test('Proceed still runs the command', async ($, on) => {
    const w = world(on)
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as never)
    for (let i = 0; i < 400 && w.opened === 0; i++) await tick()
    const ui = await $.ui.mount({ plugin: 'blast-radius', surface: 'terminal', component: 'Pane', requestId: 'blast-radius', props: pane } as never)
    await ui.press({ key: 'proceed' })
    expect(JSON.stringify(await call)).toContain('ran')
    expect(w.ran).toEqual(['rm -rf build'])
  })
})
