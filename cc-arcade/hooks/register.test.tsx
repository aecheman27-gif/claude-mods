// The hooks module under `claude plugin test` (the bun tests in ../tests cover the games' pure logic).
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On, RenderPropsOf } from 'claude-code'

const NOW = 1_800_000_000_000
const MIN = 60_000

type World = { store: Map<string, unknown>; clock: ReturnType<typeof mock.clock>; failReads: boolean }

function world(on: On, stored: Record<string, unknown> = {}): World {
  const w: World = { store: new Map(Object.entries(stored)), clock: mock.clock(on, { now: NOW }), failReads: false }
  on('session.start', async () => ({ cwd: 'C:/work' }) as never)
  on('command.register', async ($, e) => ({ value: { command: e.name } }) as never)
  on('store.get', async ($, e) => {
    if (w.failReads) throw new Error('store is busy')
    return { value: w.store.get(e.key) } as never
  })
  // stored as JSON, the way the real store keeps it
  on('store.set', async ($, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('ui.log', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }) as never)
  on('tool.call', async ($, e) => ({ result: 'done', isError: (e as { command?: string }).command === 'npm test' }) as never)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['OTHER-MOD-ROW'] }))
  return w
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
const arcade = ($: Engine, args: string) =>
  $.command.run({ command: 'arcade', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as CommandRunInput)
const band = (maxRows: number): RenderPropsOf['AbovePrompt'] =>
  ({ hasSurvey: false, isWorking: false, maxRows, bodyColumns: 120, scroll: { offset: 0, bodyRows: maxRows }, view: {} }) as never
const mount = ($: Engine, maxRows = 40) =>
  $.ui.mount({ plugin: 'cc-arcade', surface: 'terminal', component: 'AbovePrompt', props: band(maxRows), viewport: { columns: 200, rows: 80 } as never })
const ended = (turnId: string, agentId?: string) =>
  ({ reason: 'answer', isAborted: false, turnId, answer: 'done', durationMs: 1000, ...(agentId ? { agentId } : {}) }) as never

describe('the clock', () => {
  test('a new pet hatches now', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.store.get('pet')).toEqual({ xp: 0, mood: 70, at: NOW, born: NOW, tests: 0, fails: 0, commits: 0, edits: 0 })
  })

  test('a pet an older build stored with broken numbers is mended: it keeps its xp and counts', async ($, on) => {
    const w = world(on, { pet: { xp: 1121, mood: null, at: {}, born: {}, tests: 2, fails: 1, commits: 30, edits: 651, last: 'test-fail' } })
    await start($)
    // what fed it last goes with the broken time: kept, it would read as just now
    expect(w.store.get('pet')).toEqual({ xp: 1121, mood: 70, at: NOW, born: NOW, tests: 2, fails: 1, commits: 30, edits: 651 })
    expect((await arcade($, 'auto')).text).not.toContain('tests just failed')
    await w.clock.advance(MIN)
    await $.tool.call({ tool: 'Edit', file_path: 'a.ts' } as never)
    expect(w.store.get('pet')).toEqual(expect.objectContaining({ xp: 1122, edits: 652, at: NOW + MIN, born: NOW, last: 'edit' }))
  })

  test('each feed reads the store first: another session’s progress is kept, and junk there leaves this session’s pet to be fed', async ($, on) => {
    const w = world(on, { pet: { xp: 90, mood: 50, at: NOW - MIN, born: NOW - 60 * MIN, last: 'nap' } })
    await start($)
    // a pet missing its counts feeds without NaN
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    expect(w.store.get('pet')).toEqual({ xp: 92, mood: 38, at: NOW, born: NOW - 60 * MIN, tests: 0, fails: 1, commits: 0, edits: 0, last: 'test-fail' })
    w.store.set('pet', { ...(w.store.get('pet') as object), xp: 500 })
    await $.tool.call({ tool: 'Edit', file_path: 'a.ts' } as never)
    expect(w.store.get('pet')).toEqual(expect.objectContaining({ xp: 501, edits: 1 }))
    let xp = 501
    for (const junk of ['broken', {}, [1, 2], { xp: 'lots', edits: 9 }]) {
      w.store.set('pet', junk)
      await $.tool.call({ tool: 'Edit', file_path: 'a.ts' } as never)
      expect(w.store.get('pet')).toEqual(expect.objectContaining({ xp: ++xp }))
    }
  })

  test('a store that cannot be read is never written over', async ($, on) => {
    const good = { xp: 1121, mood: 60, at: NOW - MIN, born: NOW - 60 * MIN, tests: 2, fails: 0, commits: 30, edits: 651, last: 'commit' }
    const w = world(on, { pet: good })
    w.failReads = true
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: 'a.ts' } as never)
    expect(w.store.get('pet')).toEqual(good)
    w.failReads = false
    await $.tool.call({ tool: 'Edit', file_path: 'a.ts' } as never)
    expect(w.store.get('pet')).toEqual(expect.objectContaining({ xp: 1122, edits: 652 }))
  })

  test('a store that holds junk at start hatches a new pet', async ($, on) => {
    const w = world(on, { pet: [1, 2] })
    await start($)
    expect(w.store.get('pet')).toEqual(expect.objectContaining({ xp: 0, at: NOW, born: NOW }))
  })

  test('/arcade auto reads how long Claude has worked, and tests that just failed', async ($, on) => {
    const w = world(on)
    await start($)
    await $.turn.start({ text: 'go', turnId: 'T1' })
    await w.clock.advance(3 * MIN)
    expect((await arcade($, 'auto')).text).toContain('Claude has been working 3 min, time for a longer game')
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    expect(w.store.get('pet')).toEqual(expect.objectContaining({ last: 'test-fail', at: NOW + 3 * MIN }))
    expect((await arcade($, 'auto')).text).toContain('tests just failed, your pet could use a visit')
    // the picker's auto too, and the pet board is handed the time as a number
    await arcade($, '')
    const ui = await mount($)
    await ui.press({ key: 'pick:auto' })
    expect((await ui.find({ type: 'Client', key: 'board:pet' }))?.props.props).toEqual(expect.objectContaining({ now: NOW + 3 * MIN }))
  })
})

describe('the board', () => {
  test('a subagent finishing does not pause the game; the main turn finishing does', async ($, on) => {
    world(on)
    await start($)
    await arcade($, 'snake')
    const ui = await mount($)
    const done = async () => ((await ui.find({ type: 'Client', key: 'board:snake' }))?.props.props as { done: number }).done
    expect(await done()).toBe(0)
    await $.turn.start({ text: 'go', turnId: 'T1' })
    await $.turn.complete(ended('S1', 'agent-1'))
    expect(await done()).toBe(0)
    await $.turn.complete(ended('T1'))
    expect(await done()).toBe(1)
  })

  test('sized to the band, with rows left for the other mods drawing in it', async ($, on) => {
    world(on)
    await start($)
    await arcade($, 'doom')
    const ui = await mount($, 40)
    const board = await ui.find({ type: 'Client', key: 'board:doom' })
    expect(board?.props.width).toBe(120)
    // the back and close row, the board, and a few rows for the rest of the band
    expect(board?.props.height).toBe(35)
    expect((await ui.findAll({})).map(x => x.text).join('\n')).toContain('OTHER-MOD-ROW')
  })
})
