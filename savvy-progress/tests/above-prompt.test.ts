// The band above the prompt is shared: the flow's row stacks above what the host and the other mods draw there.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__savvy-progress__progress'
const BAND = { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 140, scroll: { offset: 0, bodyRows: 20 }, view: {} }

function world(on: On) {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  on('session.start', async () => ({ cwd: 'C:/work' }) as never)
  on('settings.read', async () => ({ value: {} }) as never)
  on('tool.register', async () => ({ value: undefined }) as never)
  on('command.register', async ($, e) => ({ value: { command: e.name } }) as never)
  // another mod's row in the band, beneath this one
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: ['BELOW'] }))
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)

describe('AbovePrompt', () => {
  test('the flow row keeps the rows beneath it, on every surface', async ($, on) => {
    world(on)
    await start($)
    await $.tool.call({ tool: TOOL, title: 'Ship it', total: 3, done: 1, phase: 'delegate' } as never)
    let n = 0
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'savvy-progress', surface, component: 'AbovePrompt', props: BAND, requestId: `band-${++n}` } as never)
      expect(await ui.find({ key: 'savvy-dismiss' } as never)).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'BELOW' } as never)).toBeDefined()
      await ui.unmount()
    }
  })

  test('with no flow the band is left as it is', async ($, on) => {
    world(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', component: 'AbovePrompt', props: BAND, requestId: 'band-0' } as never)
    expect(await ui.find({ type: 'Text', text: 'BELOW' } as never)).toBeDefined()
    expect(await ui.find({ key: 'savvy-dismiss' } as never)).toBeUndefined()
  })
})
