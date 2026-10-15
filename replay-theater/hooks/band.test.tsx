// my-claude-mods: the patched band row stacks above the other mods' rows,
// yields to a survey, sizes the replay to the render props, and records only
// the main loop's edits that went through, within bounds.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

function world(on: On, opts: { isPlaced?: boolean; cwd?: string } = {}) {
  const clock = mock.clock(on)
  on('session.start', async () => ({ cwd: opts.cwd ?? 'C:/work' }) as never)
  on('session.cwd', async () => ({ value: opts.cwd ?? 'C:/work' }) as never)
  on('command.register', async ($, e) => ({ value: { command: e.name } }) as never)
  on('fs.exists', async () => ({ value: true }) as never)
  on('fs.read', async () => ({ value: 'old line\n' }) as never)
  // A path naming `denied` is refused, one naming `broken` errors; the rest go through.
  on('tool.call', async ($, e) => {
    const path = String((e as { file_path?: string }).file_path ?? '')
    if (path.includes('denied')) return { deny: 'not allowed' } as never
    if (path.includes('broken')) return { isError: true, result: 'boom', text: 'boom' } as never
    return { result: {}, text: 'ok' } as never
  })
  on('turn.start', async ($, e) => e as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('ui.open', async () => ({ value: { isPlaced: opts.isPlaced ?? true } }) as never)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['OTHER-MOD-ROW'] }))
  return { clock }
}

const band: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} } as never
const pane: RenderPropsOf['Pane'] = { title: 'Replay Theater', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never
const textOf = async (ui: { findAll: (q: object) => Promise<{ text: string }[]> }) => (await ui.findAll({}))[0]?.text ?? ''
const mount = ($: Engine, props: object = band) => $.ui.mount({ plugin: 'replay-theater', surface: 'terminal', component: 'AbovePrompt', props: props as never })
const mountPane = ($: Engine) => $.ui.mount({ plugin: 'replay-theater', surface: 'terminal', component: 'Pane', requestId: 'replay-theater', props: pane } as never)
const start = ($: Engine) => $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
const turn = async ($: Engine, calls: object[]) => {
  await $.turn.start({ turnId: 't1' } as never)
  for (const c of calls) await $.tool.call(c as never)
  await $.turn.complete({ turnId: 't1', answer: '', toolUses: [], index: 0 } as never)
}
const edit = (file = 'a.txt', extra: object = {}) => ({ tool: 'Edit', file_path: `C:/work/${file}`, old_string: 'old line', new_string: 'new line', ...extra })
const lines = (word: string, n: number) => Array.from({ length: n }, (_, k) => `${word} ${k} ${'x'.repeat(200)}`).join('\n')
const replay = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }) => {
  const ran = $.command.run({ command: 'replay', args: '' } as never)
  await clock.advance(500)
  return ran
}

describe('band', () => {
  test('no edits: only the other rows', async ($, on) => {
    world(on)
    await start($)
    const text = await textOf(await mount($))
    expect(text).toBe('OTHER-MOD-ROW')
  })

  test('after a turn with an edit: the Replay row sits above the other rows, which stay', async ($, on) => {
    world(on)
    await start($)
    await turn($, [edit()])
    const ui = await mount($)
    const text = await textOf(ui)
    expect(await ui.find({ type: 'Button', key: 'open-replay' })).toBeTruthy()
    expect(text).toContain('OTHER-MOD-ROW')
    expect(text.indexOf('Replay')).toBeLessThan(text.indexOf('OTHER-MOD-ROW'))
  })

  test('a survey holds the band: only what is below draws', async ($, on) => {
    world(on)
    await start($)
    await turn($, [edit()])
    const ui = await mount($, { ...band, hasSurvey: true })
    expect(await textOf(ui)).toBe('OTHER-MOD-ROW')
    expect(await ui.find({ type: 'Button', key: 'open-replay' })).toBeUndefined()
  })

  test('in the band the replay fits the band: its rows and columns come from the props', async ($, on) => {
    const { clock } = world(on, { isPlaced: false })
    await start($)
    await turn($, [{ ...edit(), old_string: lines('old', 30), new_string: lines('new', 30) }])
    await replay($, clock)
    const ui = await mount($, { ...band, maxRows: 10, bodyColumns: 60 })
    const diff = await ui.findAll({ type: 'Text', text: /^[-+] (old|new) / })
    expect(diff.length).toBe(3) // maxRows 10 less 7
    expect(diff.every(d => d.text.length <= 56)).toBe(true) // bodyColumns 60 less 4
    expect((await ui.find({ type: 'Text', text: /more lines/ }))?.text).toContain('57 more lines')
  })

  test('in the pane the diff fits the pane columns', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await turn($, [{ ...edit(), old_string: lines('old', 2), new_string: lines('new', 2) }])
    await replay($, clock)
    const diff = await (await mountPane($)).findAll({ type: 'Text', text: /^[-+] (old|new) / })
    expect(diff.length).toBe(4)
    expect(diff.every(d => d.text.length <= 46)).toBe(true) // bodyColumns 50 less 4
  })
})

// Stands in for flightdeck: its pane is open and drawn from the session's start
// (`dock`), and draws a log with what lies beneath under it.
const deck = {
  name: 'flightdeck',
  register: ((on: On) => {
    on('session.start', async ($, e, next) => {
      await $.state.set({ plugin: 'flightdeck', key: 'dock' } as never, true as never)
      return next(e)
    })
    on('ui.render', { component: 'Pane', requestId: 'flightdeck' }, async ($, e, next) => {
      const { Box, Text } = $.ui.resolve(e)
      return Box({ flexDirection: 'column', children: [Text({ children: 'session log' }), await next(e)] })
    })
  }) as never,
}
const deckPane = ($: Engine) =>
  $.ui.mount({ plugin: 'replay-theater', surface: 'terminal', component: 'Pane', requestId: 'flightdeck', props: { ...pane, title: 'Flightdeck', bodyColumns: 64 } } as never)

describe("flightdeck's pane", () => {
  test('while it is open the Replay row leaves the band and sits under its session log', { plugins: [deck] }, async ($, on) => {
    world(on)
    await start($)
    await turn($, [edit()])
    expect(await textOf(await mount($))).toBe('OTHER-MOD-ROW')
    const ui = await deckPane($)
    const text = await textOf(ui)
    expect(text.indexOf('session log')).toBeLessThan(text.indexOf('▶ Replay: 1 edit'))
    expect(await ui.find({ type: 'Button', key: 'open-replay' })).toBeTruthy()
  })

  test('no edits: nothing is added to it', { plugins: [deck] }, async ($, on) => {
    world(on)
    await start($)
    expect(await textOf(await deckPane($))).not.toContain('Replay')
  })
})

describe('recording', () => {
  test("subagents' edits, refused edits and failed edits are not recorded", async ($, on) => {
    world(on)
    await start($)
    await turn($, [edit('sub.txt', { agentId: 'agent-1' }), edit('denied.txt'), edit('broken.txt')])
    expect(await textOf(await mount($))).toBe('OTHER-MOD-ROW')
    await turn($, [edit('sub.txt', { agentId: 'agent-1' }), edit('denied.txt'), edit('a.txt')])
    expect(await textOf(await mount($))).toContain('▶ Replay: 1 edit (press r)')
  })

  test('a large Write keeps at most MAX_LCS_LINES lines a side and says it was cut', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await turn($, [{ tool: 'Write', file_path: 'C:/work/big.txt', content: lines('new', 5000) }])
    await replay($, clock)
    const text = await textOf(await mountPane($))
    expect(text).toContain('Write · rewrite · first 400 lines')
    expect(text).toContain('+400')
    expect(text).toContain('389 more lines') // 1 old + 400 new, 12 shown
  })

  test('a Windows path shows relative to the cwd whatever its slashes and drive-letter case', async ($, on) => {
    const { clock } = world(on, { cwd: 'C:\\Work' })
    await start($)
    await turn($, [edit('', { file_path: 'c:\\work\\src\\a.txt' }), edit('', { file_path: 'C:/Work/b.txt' }), edit('', { file_path: 'C:\\Workshop\\c.txt' })])
    await replay($, clock)
    const ui = await mountPane($)
    const file = async () => (await ui.find({ type: 'Text', text: /\.txt$/ }))?.text
    expect(await file()).toBe('src\\a.txt')
    await ui.press({ key: 'next' })
    expect(await file()).toBe('b.txt')
    await ui.press({ key: 'next' })
    expect(await file()).toBe('C:\\Workshop\\c.txt')
  })

  test('a long turn keeps the newest 200 steps', async ($, on) => {
    world(on)
    await start($)
    await turn($, Array.from({ length: 250 }, (_, k) => edit(`f${k}.txt`)))
    expect(await textOf(await mount($))).toContain('▶ Replay: 200 edits (press r)')
  })
})
