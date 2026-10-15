import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { byOwnShell, keyOf, mcpPaths, named, remembered, writes } from './register'

const MIN = 60_000
const NOW = Date.parse('2026-10-08T20:00:00Z')
type Answer = 'Cancel' | 'Edit anyway' | 'close'

function world(on: On, mtimes: Record<string, number>, answer: Answer = 'Cancel', clockFails = false) {
  const clock = clockFails ? undefined : mock.clock(on, { now: NOW })
  if (clockFails)
    on('clock.now', async () => {
      throw new Error('boom')
    })
  const w = { asked: [] as string[], ran: [] as string[], mtimes, clock, answer }
  on('fs.stat', async ($, e) => {
    const m = mtimes[e.path.replace(/\\/g, '/')]
    if (m === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: m, isLink: false } } as never
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
    const question = e.questions[0]?.question ?? ''
    w.asked.push(question)
    if (w.answer === 'close') return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [question]: w.answer } } } as never
  })
  on('tool.call', async ($, e) => {
    w.ran.push(e.tool)
    return { result: {} } as never
  })
  return w
}

const write = ($: Engine, file_path: string) => $.tool.call({ tool: 'Write', file_path, content: 'x' } as never) as Promise<{ deny?: string }>
const edit = ($: Engine, file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' } as never) as Promise<{ deny?: string }>

describe('gate', () => {
  test('outside change 2m ago + Cancel is denied', async ($, on) => {
    const w = world(on, { 'C:/shared/plan.md': NOW - 2 * MIN })
    const r = await edit($, 'C:/shared/plan.md')
    expect(w.asked[0]).toContain('shared/plan.md was changed outside this chat 2m ago')
    expect(r.deny).toContain('did not approve')
    expect(w.ran).toEqual([])
  })

  test('+ Edit anyway proceeds', async ($, on) => {
    const w = world(on, { 'C:/shared/plan.md': NOW - 2 * MIN }, 'Edit anyway')
    const r = await edit($, 'C:/shared/plan.md')
    expect(r.deny).toBeUndefined()
    expect(w.ran).toEqual(['Edit'])
  })

  test('closed question is denied', async ($, on) => {
    const w = world(on, { 'C:/shared/plan.md': NOW - 30_000 }, 'close')
    const r = await write($, 'C:/shared/plan.md')
    expect(r.deny).toBeDefined()
    expect(w.ran).toEqual([])
  })

  test('an old change does not ask', async ($, on) => {
    const w = world(on, { 'C:/shared/old.py': NOW - 30 * MIN })
    await edit($, 'C:/shared/old.py')
    expect(w.asked).toEqual([])
    expect(w.ran).toEqual(['Edit'])
  })

  test('a new file does not ask', async ($, on) => {
    const w = world(on, {})
    await write($, 'C:/shared/new.py')
    expect(w.asked).toEqual([])
  })

  test('the version Claude read does not ask; a later outside change does', async ($, on) => {
    const w = world(on, { 'C:/shared/a.py': NOW - MIN })
    await $.tool.call({ tool: 'Read', file_path: 'C:/shared/a.py' } as never)
    await edit($, 'C:/shared/a.py')
    expect(w.asked).toEqual([])
    w.mtimes['C:/shared/a.py'] = NOW + 5_000 // Gemini saves
    await w.clock?.advance(60_000)
    await edit($, 'C:/shared/a.py')
    expect(w.asked).toHaveLength(1)
  })

  test("a change made during Claude's own shell command naming the file does not ask; another file changed meanwhile does", async ($, on) => {
    const mtimes = { 'C:/shared/fmt.py': NOW - 20 * MIN, 'C:/shared/other.py': NOW - 20 * MIN }
    on('tool.call', { tool: 'Bash' }, async () => {
      mtimes['C:/shared/fmt.py'] = NOW // the formatter rewrote it
      mtimes['C:/shared/other.py'] = NOW // Gemini saved at the same moment
      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    })
    const w = world(on, mtimes)
    await $.tool.call({ tool: 'Bash', command: 'ruff format C:\\Shared\\FMT.py' } as never)
    await edit($, 'C:/shared/fmt.py')
    expect(w.asked).toEqual([])
    await edit($, 'C:/shared/other.py')
    expect(w.asked).toHaveLength(1)
  })

  test("a change made while another agent's unrelated shell command ran asks", async ($, on) => {
    const mtimes = { 'C:/shared/plan.md': NOW - 20 * MIN }
    on('tool.call', { tool: 'Bash' }, async () => {
      mtimes['C:/shared/plan.md'] = NOW // Gemini saved while the tests ran
      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    })
    const w = world(on, mtimes)
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    await edit($, 'C:/shared/plan.md')
    expect(w.asked).toHaveLength(1)
  })

  test('path casing does not hide the version Claude read', async ($, on) => {
    const w = world(on, { 'C:/Shared/Plan.md': NOW - MIN, 'c:/shared/plan.md': NOW - MIN })
    await $.tool.call({ tool: 'Read', file_path: 'C:\\Shared\\Plan.md' } as never)
    await edit($, 'c:/shared/plan.md')
    expect(w.asked).toEqual([])
  })

  test('an error inside the guard denies', async ($, on) => {
    const w = world(on, { 'C:/shared/x.py': NOW - MIN }, 'Edit anyway', true)
    const r = await edit($, 'C:/shared/x.py')
    expect(r.deny).toContain('check failed')
    expect(w.ran).toEqual([])
  })

  test('Cancel sticks: reading the file does not let the next edit through unasked; Edit anyway clears it', async ($, on) => {
    const w = world(on, { 'C:/shared/plan.md': NOW - 2 * MIN })
    expect((await edit($, 'C:/shared/plan.md')).deny).toContain('do not change it another way (a shell command')
    await $.tool.call({ tool: 'Read', file_path: 'C:/shared/plan.md' } as never)
    expect((await edit($, 'C:/shared/plan.md')).deny).toContain('did not approve')
    expect(w.asked).toHaveLength(2)
    w.answer = 'Edit anyway'
    expect((await edit($, 'C:/shared/plan.md')).deny).toBeUndefined()
    await edit($, 'C:/shared/plan.md')
    expect(w.asked).toHaveLength(3)
    expect(w.ran).toEqual(['Read', 'Edit', 'Edit'])
  })

  test('a Cancel ages out with the window', async ($, on) => {
    const w = world(on, { 'C:/shared/plan.md': NOW - 2 * MIN })
    await edit($, 'C:/shared/plan.md')
    await w.clock?.advance(9 * MIN)
    await edit($, 'C:/shared/plan.md')
    expect(w.asked).toHaveLength(1)
    expect(w.ran).toEqual(['Edit'])
  })

  test('a shell command that writes a recently changed file asks first; one that only reads it does not', async ($, on) => {
    const w = world(on, { 'C:/shared/plan.md': NOW - 2 * MIN, 'C:/shared/notes.txt': NOW - 2 * MIN })
    const shell = (tool: string, command: string) => $.tool.call({ tool, command } as never) as Promise<{ deny?: string }>
    const refused = [
      await shell('PowerShell', "(Get-Content C:\\shared\\plan.md) -replace 'a','b' | Set-Content C:\\shared\\plan.md"),
      await shell('Bash', "sed -i 's/a/b/' C:/shared/plan.md"),
      await shell('Bash', `python -c "open('C:/shared/notes.txt','w').write('x')"`),
    ]
    for (const r of refused) expect(r.deny).toContain('did not approve')
    await shell('Bash', 'cat C:/shared/plan.md')
    expect(w.asked).toHaveLength(3)
    expect(w.ran).toEqual(['Bash'])
  })

  test("a long command of Claude's that only reads a file does not make an outside edit to it its own", async ($, on) => {
    const mtimes = { 'C:/lab/run.yaml': NOW - 20 * MIN }
    on('tool.call', { tool: 'Bash' }, async () => {
      mtimes['C:/lab/run.yaml'] = NOW // the person retunes the config while the acquisition runs
      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    })
    const w = world(on, mtimes)
    await $.tool.call({ tool: 'Bash', command: 'python run_daq.py --config C:\\lab\\run.yaml' } as never)
    await edit($, 'C:/lab/run.yaml')
    expect(w.asked).toHaveLength(1)
  })

  test('an MCP tool that writes a recently changed file asks; one that reads it does not', async ($, on) => {
    const w = world(on, { 'C:/shared/plan.md': NOW - 2 * MIN })
    const r = (await $.tool.call({ tool: 'mcp__filesystem__write_file', path: 'C:/shared/plan.md', content: 'x' } as never)) as { deny?: string }
    expect(r.deny).toContain('did not approve')
    await $.tool.call({ tool: 'mcp__filesystem__read_text_file', path: 'C:/shared/plan.md' } as never)
    expect(w.asked).toHaveLength(1)
    expect(w.ran).toEqual(['mcp__filesystem__read_text_file'])
  })
})

test('helpers', async () => {
  expect(keyOf('C:\\Work\\A.py')).toBe('c:/work/a.py')
  expect(keyOf('/home/me/A.py')).toBe('/home/me/A.py')
  const w = (command: string) => [{ from: 2000, to: 3000, command }]
  expect(byOwnShell(1000, 'C:/w/a.py', w('black C:\\W\\A.py'))).toBe(true)
  expect(byOwnShell(9000, 'C:/w/a.py', w('black C:\\W\\A.py'))).toBe(false)
  expect(byOwnShell(1000, 'C:/w/a.py', w('npm test'))).toBe(false)
  expect(byOwnShell(1000, 'C:/w/a.py', w('cat data.py'))).toBe(false)
  expect(byOwnShell(1000, '/home/A.py', w('black /home/a.py'))).toBe(false)
  expect(byOwnShell(1000, 'C:/lab/run.yaml', w('python run_daq.py --config C:\\lab\\run.yaml'))).toBe(false)
  expect(byOwnShell(1000, 'C:/lab/run.yaml', w('Set-Content C:\\lab\\run.yaml $x'))).toBe(true)
  for (const c of ['Set-Content a.txt x', "sed -i 's/a/b/' a.txt", 'echo hi > out.txt', 'perl -pi -e s/a/b/ a.txt', `python -c "open('a.txt','w').write('x')"`, 'ruff format a.py', 'prettier --write a.ts', 'Copy-Item a.txt b.txt', 'git checkout -- a.txt']) {
    expect(writes(c), c).toBe(true)
  }
  for (const c of ['npm test 2>&1', 'cat plan.md', 'git diff plan.md', 'python run_daq.py --config run.yaml', 'node -e "[1].map(x => x)"', 'dir > $null', 'sed -n 1p a.txt', 'ruff check a.py']) {
    expect(writes(c), c).toBe(false)
  }
  expect(named(`Set-Content -Path "C:\\My Files\\a.txt" -Value 1; sed -i 's/x/y/' b.md`)).toEqual(['C:\\My Files\\a.txt', 'b.md'])
  expect(named('curl -o out.json https://example.test/data.json')).toEqual(['out.json'])
  expect(mcpPaths('mcp__fs__move_file', { source: 'C:/a.txt', destination: 'C:/b.txt' })).toEqual(['C:/a.txt', 'C:/b.txt'])
  expect(mcpPaths('mcp__fs__read_file', { path: 'C:/a.txt' })).toEqual([])
  expect(mcpPaths('Write', { file_path: 'C:/a.txt' })).toEqual([])
})

test('seen keeps only recent versions, at most 500', async () => {
  const all = { 'c:/old.py': NOW - 11 * MIN, 'c:/new.py': NOW - MIN }
  expect(remembered(all, 'c:/a.py', NOW, NOW - 10 * MIN)).toEqual({ 'c:/new.py': NOW - MIN, 'c:/a.py': NOW })
  const many = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`c:/f${i}.py`, NOW - i]))
  const kept = remembered(many, 'c:/a.py', NOW + 1, NOW - 10 * MIN)
  expect(Object.keys(kept)).toHaveLength(500)
  expect(kept['c:/a.py']).toBe(NOW + 1)
  expect(kept['c:/f599.py']).toBeUndefined()
})
