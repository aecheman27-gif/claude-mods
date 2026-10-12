import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On, RenderPropsOf } from 'claude-code'

import { callOf, counted, failureOf } from './register'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const MIN = 60_000
const PORT = 'python read_modbus.py --port COM3'
const ERR = 'SerialException: could not open port COM3: Access is denied.\nTraceback (most recent call last):'

type World = {
  toasts: string[]
  ran: string[]
  failing: Set<string>
  denying: Set<string>
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
}

function world(on: On): World {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  const w: World = { toasts: [], ran: [], failing: new Set(), denying: new Set(), store, clock }
  on('session.start', async () => ({ cwd: 'C:/work' }) as never)
  on('command.register', async ($, e) => ({ value: { command: e.name } }) as never)
  on('agent.list', async () => ({ value: [{ id: 'agent-flash-1', description: 'Flash the PLC', type: 'general-purpose', status: 'running' }] }) as never)
  on('ui.toast', async ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['OTHER-MOD-ROW'] }))
  on('tool.call', async ($, e) => {
    const command = String((e as { command?: string }).command ?? '')
    w.ran.push(command)
    if (w.denying.has(command)) return { deny: 'The user rejected this tool use.' } as never
    if (w.failing.has(command)) return { isError: true, result: ERR, text: ERR } as never
    return { result: { stdout: 'ok', stderr: '', interrupted: false } } as never
  })
  return w
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
const bash = ($: Engine, command: string, agentId?: string) => $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'retry-breaker', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as CommandRunInput)
const band = (hasSurvey = false): RenderPropsOf['AbovePrompt'] =>
  ({ hasSurvey, isWorking: true, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} }) as never
const mount = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal', hasSurvey = false) =>
  $.ui.mount({ plugin: 'retry-breaker', surface, component: 'AbovePrompt', props: band(hasSurvey) })
const textOf = async (ui: { findAll: (q: object) => Promise<{ text: string }[]> }) => (await ui.findAll({}))[0]?.text ?? ''
const times = async (n: number, f: () => Promise<unknown>) => {
  for (let i = 0; i < n; i++) await f()
}

describe('streaks', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: 3 identical failures give one toast and a band row above other rows`, async ($, on) => {
      const w = world(on)
      await start($)
      w.failing.add(PORT)
      await times(2, () => bash($, PORT))
      expect(w.toasts).toEqual([])
      expect(await textOf(await mount($, surface))).not.toContain('[LOOP]')
      await bash($, PORT)
      expect(w.toasts).toEqual([`retry-breaker: Claude failed the same Bash 3× in a row: ${PORT}`])
      const ui = await mount($, surface)
      const text = await textOf(ui)
      expect(text).toContain(`[LOOP] Claude: ${PORT} failed 3× (last error: SerialException: could not open port COM3: Access is denied.)`)
      expect(text).not.toContain('Traceback')
      expect(text.indexOf('[LOOP]')).toBeLessThan(text.indexOf('OTHER-MOD-ROW'))
      // more failures update the count without new toasts
      await times(2, () => bash($, PORT))
      expect(w.toasts).toHaveLength(1)
      expect(await textOf(ui)).toContain('failed 5×')
    })
  }

  test('a success in between resets the streak', async ($, on) => {
    const w = world(on)
    await start($)
    w.failing.add(PORT)
    await times(2, () => bash($, PORT))
    w.failing.delete(PORT)
    await bash($, PORT)
    w.failing.add(PORT)
    await times(2, () => bash($, PORT))
    expect(w.toasts).toEqual([])
    await bash($, PORT)
    expect(w.toasts).toHaveLength(1)
  })

  test('a success clears a shown row; the next streak toasts again', async ($, on) => {
    const w = world(on)
    await start($)
    w.failing.add(PORT)
    await times(3, () => bash($, PORT))
    w.failing.delete(PORT)
    await bash($, PORT)
    expect(await textOf(await mount($))).not.toContain('[LOOP]')
    w.failing.add(PORT)
    await times(3, () => bash($, PORT))
    expect(w.toasts).toHaveLength(2)
  })

  test('a different command resets; whitespace differences do not', async ($, on) => {
    const w = world(on)
    await start($)
    w.failing.add(PORT).add('pytest -x').add(`  ${PORT.replace(/ /g, '   ')} `)
    await times(2, () => bash($, PORT))
    await bash($, 'pytest -x')
    await bash($, PORT)
    expect(w.toasts).toEqual([])
    await bash($, `  ${PORT.replace(/ /g, '   ')} `)
    await bash($, PORT)
    expect(w.toasts).toHaveLength(1)
  })

  test('subagents are tracked separately from each other and from main, labelled by the roster', async ($, on) => {
    const w = world(on)
    await start($)
    w.failing.add(PORT)
    await bash($, PORT, 'agent-flash-1')
    await bash($, PORT)
    await bash($, PORT, 'agent-zz9abcdef0123')
    await bash($, PORT, 'agent-flash-1')
    await bash($, PORT)
    await bash($, PORT, 'agent-zz9abcdef0123')
    expect(w.toasts).toEqual([])
    await bash($, PORT, 'agent-flash-1')
    expect(w.toasts).toEqual([`retry-breaker: Flash the PLC failed the same Bash 3× in a row: ${PORT}`])
    await bash($, PORT, 'agent-zz9abcdef0123')
    expect(w.toasts[1]).toContain('retry-breaker: agent agent-zz failed the same Bash 3×')
    await bash($, PORT)
    expect(w.toasts).toHaveLength(3)
    const text = await textOf(await mount($))
    expect(text).toContain('[LOOP] Flash the PLC:')
    expect(text).toContain('[LOOP] agent agent-zz:')
    expect(text).toContain('[LOOP] Claude:')
  })

  test('more than 3 loops show 3 rows then +N more', async ($, on) => {
    const w = world(on)
    await start($)
    w.failing.add(PORT)
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) await times(3, () => bash($, PORT, id))
    const text = await textOf(await mount($))
    expect(text.split('[LOOP]').length - 1).toBe(3)
    expect(text).toContain('+2 more')
  })

  test('never denies: results pass through unchanged, a deny counts as a failure', async ($, on) => {
    const w = world(on)
    await start($)
    w.failing.add(PORT)
    for (let i = 0; i < 4; i++) {
      const r = (await bash($, PORT)) as { isError?: boolean; text?: string; deny?: string }
      expect(r.deny).toBeUndefined()
      expect(r.isError).toBe(true)
      expect(r.text).toBe(ERR)
    }
    const ok = (await bash($, 'echo hi')) as { result?: { stdout?: string }; deny?: string }
    expect(ok.deny).toBeUndefined()
    expect(ok.result?.stdout).toBe('ok')
    expect(w.ran).toHaveLength(5)
    w.denying.add('rm -rf build')
    for (let i = 0; i < 3; i++) expect((await bash($, 'rm -rf build')).deny).toBe('The user rejected this tool use.')
    expect(w.toasts).toHaveLength(2)
    expect(await textOf(await mount($))).toContain('last error: The user rejected this tool use.')
  })

  test('non-shell tools are keyed by their input', async ($, on) => {
    on('tool.call', { tool: 'Read' }, async () => ({ isError: true, result: 'File does not exist.', text: 'File does not exist.' }) as never)
    const w = world(on)
    await start($)
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Read', file_path: 'C:/work/missing.txt' } as never)
    expect(w.toasts[0]).toContain('failed the same Read 3× in a row: Read {"file_path":"C:/work/missing.txt"}')
  })

  test('idle streaks older than 30 minutes are dropped', async ($, on) => {
    const w = world(on)
    await start($)
    w.failing.add(PORT)
    await times(2, () => bash($, PORT, 'old'))
    await w.clock.advance(31 * MIN)
    await bash($, PORT)
    const text = (await run($, '')).text ?? ''
    expect(text).toContain('Claude: python')
    expect(text).not.toContain('agent old')
  })
})

describe('band', () => {
  test('Dismiss hides the row until the streak resets', async ($, on) => {
    const w = world(on)
    await start($)
    w.failing.add(PORT)
    await times(3, () => bash($, PORT))
    const ui = await mount($)
    await ui.press({ key: 'dismiss-main' })
    expect(await textOf(ui)).not.toContain('[LOOP]')
    expect(await textOf(ui)).toContain('OTHER-MOD-ROW')
    await bash($, PORT)
    expect(await textOf(ui)).not.toContain('[LOOP]')
    expect(w.toasts).toHaveLength(1)
  })

  test('hidden while a survey shows', async ($, on) => {
    const w = world(on)
    await start($)
    w.failing.add(PORT)
    await times(3, () => bash($, PORT))
    const text = await textOf(await mount($, 'terminal', true))
    expect(text).not.toContain('[LOOP]')
    expect(text).toContain('OTHER-MOD-ROW')
  })
})

describe('command', () => {
  test('status lists active streaks', async ($, on) => {
    const w = world(on)
    await start($)
    expect((await run($, '')).text).toBe('retry-breaker: on, threshold 3. No failing streaks.')
    w.failing.add(PORT)
    await times(2, () => bash($, PORT))
    const text = (await run($, 'status')).text ?? ''
    expect(text).toContain('Active streaks:')
    expect(text).toContain(`${PORT} failed 2×`)
  })

  test('threshold N is stored and used; bad values are refused', async ($, on) => {
    const w = world(on)
    await start($)
    expect((await run($, 'threshold 1')).text).toContain('Usage')
    expect((await run($, 'threshold x')).text).toContain('Usage')
    expect((await run($, 'threshold 2')).text).toContain('after 2 identical failures')
    expect(w.store.get('threshold')).toBe(2)
    w.failing.add(PORT)
    await times(2, () => bash($, PORT))
    expect(w.toasts).toEqual([`retry-breaker: Claude failed the same Bash 2× in a row: ${PORT}`])
    expect((await run($, '')).text).toContain('threshold 2')
  })

  test('off disables tracking and clears rows; on resumes', async ($, on) => {
    const w = world(on)
    await start($)
    w.failing.add(PORT)
    await times(3, () => bash($, PORT))
    expect((await run($, 'off')).text).toContain('is off')
    expect(w.store.get('isOff')).toBe(true)
    expect(await textOf(await mount($))).not.toContain('[LOOP]')
    await times(5, () => bash($, PORT))
    expect(w.toasts).toHaveLength(1)
    expect((await run($, '')).text).toContain('retry-breaker: off')
    expect((await run($, 'on')).text).toContain('is on')
    await times(3, () => bash($, PORT))
    expect(w.toasts).toHaveLength(2)
  })
})

describe('helpers', () => {
  test('callOf normalizes shells and keys other tools by stable JSON', () => {
    expect(callOf({ tool: 'PowerShell', command: '  Get-Item   COM3 \n' }).short).toBe('Get-Item COM3')
    const a = callOf({ tool: 'Grep', pattern: 'x', path: 'C:/a', agentId: 'z' })
    const b = callOf({ tool: 'Grep', path: 'C:/a', pattern: 'x' })
    expect(a.key).toBe(b.key)
    expect(callOf({ tool: 'Write', file_path: 'a', content: 'y'.repeat(2000) }).key.length).toBeLessThan(520)
  })

  test('failureOf reads errors and denies, not successes', () => {
    expect(failureOf({ isError: true, result: undefined, text: '\n  Timeout reading register 40001  \nmore' })).toBe('Timeout reading register 40001')
    expect(failureOf({ deny: 'no' })).toBe('no')
    expect(failureOf({ result: 'fine' })).toBeUndefined()
  })

  test('counted keeps at most 50 loops, newest first', () => {
    let all = {}
    for (let i = 0; i < 60; i++) all = counted(all, `loop${i}`, { key: 'k', short: 'k', tool: 'Bash' }, 'e', NOW + i, 3).all
    const keys = Object.keys(all)
    expect(keys).toHaveLength(50)
    expect(keys).toContain('loop59')
    expect(keys).not.toContain('loop9')
  })
})
