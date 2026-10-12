import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { byOwnShell, keyOf, remembered } from './register'

const MIN = 60_000
const NOW = Date.parse('2026-10-08T20:00:00Z')
type Answer = 'Cancel' | 'Edit anyway' | 'close'

function world(on: On, mtimes: Record<string, number>, answer: Answer = 'Cancel', clockFails = false) {
  const clock = clockFails ? undefined : mock.clock(on, { now: NOW })
  if (clockFails)
    on('clock.now', async () => {
      throw new Error('boom')
    })
  const w = { asked: [] as string[], ran: [] as string[], mtimes, clock }
  on('fs.stat', async ($, e) => {
    const m = mtimes[e.path.replace(/\\/g, '/')]
    if (m === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: m, isLink: false } } as never
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
    w.asked.push(e.questions[0].question)
    if (answer === 'close') return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: answer } } } as never
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
