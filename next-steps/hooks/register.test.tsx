import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { stepsFrom } from './register'

const TOOL = 'mcp__next-steps__next_steps'

function world(on: On) {
  const w = { sent: [] as { text: string; asUser?: boolean }[], tools: [] as string[] }
  on('session.start', async () => ({ cwd: 'C:/work' }) as never)
  on('tool.register', async ($, e) => {
    w.tools.push(e.name)
    return { value: undefined } as never
  })
  on('prompt.submit', async ($, e) => {
    w.sent.push({ text: e.text, asUser: (e.origin as { asUser?: boolean }).asUser })
    return { text: e.text } as never
  })
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }) as never)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['OTHER-MOD-ROW'] }))
  return w
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
const offer = ($: Engine, input: object, agentId?: string) => $.tool.call({ tool: TOOL, ...input, ...(agentId ? { agentId } : {}) } as never)
const band = (isWorking = false): RenderPropsOf['AbovePrompt'] =>
  ({ hasSurvey: false, isWorking, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }) as never
const textOf = async (ui: { findAll: (q: object) => Promise<{ text: string }[]> }) => (await ui.findAll({}))[0]?.text ?? ''
const STEPS = {
  question: 'What next?',
  steps: [
    { label: 'Run tests', prompt: 'Run the tests and fix any failures' },
    { label: 'Commit', prompt: 'Commit these changes' },
  ],
}

describe('card', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: offered steps show as buttons above other rows; a click sends one as the user`, async ($, on) => {
      const w = world(on)
      await start($)
      expect(w.tools).toEqual(['next_steps'])
      const r = await offer($, STEPS)
      expect(JSON.stringify(r)).toContain('shown: 2 buttons')
      const ui = await $.ui.mount({ plugin: 'next-steps', surface, component: 'AbovePrompt', props: band() })
      const text = await textOf(ui)
      expect(text).toContain('[NEXT]')
      expect(text).toContain('What next?')
      expect(text).toContain('Run tests')
      expect(text).toContain('Commit')
      expect(text.indexOf('[NEXT]')).toBeLessThan(text.indexOf('OTHER-MOD-ROW'))
      await ui.press({ key: 'step-1' })
      expect(w.sent).toEqual([{ text: 'Commit these changes', asUser: true }])
      expect(await textOf(ui)).not.toContain('[NEXT]')
    })
  }

  test('hidden while Claude works; typing anything clears it', async ($, on) => {
    world(on)
    await start($)
    await offer($, STEPS)
    const working = await $.ui.mount({ plugin: 'next-steps', surface: 'terminal', component: 'AbovePrompt', props: band(true) })
    expect(await textOf(working)).not.toContain('[NEXT]')
    await $.prompt.submit({ text: 'actually, do something else', origin: { kind: 'composer' }, wait: false } as never)
    const idle = await $.ui.mount({ plugin: 'next-steps', surface: 'terminal', component: 'AbovePrompt', props: band() })
    expect(await textOf(idle)).not.toContain('[NEXT]')
  })

  test('✕ dismisses without sending', async ($, on) => {
    const w = world(on)
    await start($)
    await offer($, STEPS)
    const ui = await $.ui.mount({ plugin: 'next-steps', surface: 'terminal', component: 'AbovePrompt', props: band() })
    await ui.press({ key: 'dismiss' })
    expect(await textOf(ui)).not.toContain('[NEXT]')
    expect(w.sent).toEqual([])
  })

  test('a subagent cannot put up a card; bad input is refused', async ($, on) => {
    world(on)
    await start($)
    expect(JSON.stringify(await offer($, STEPS, 'agent-1'))).toContain('ignored')
    expect(JSON.stringify(await offer($, { steps: [] }))).toContain('non-empty')
    const ui = await $.ui.mount({ plugin: 'next-steps', surface: 'terminal', component: 'AbovePrompt', props: band() })
    expect(await textOf(ui)).not.toContain('[NEXT]')
  })

  test('the hint goes last in the system prompt, only when the tool is offered', async ($, on) => {
    world(on)
    await start($)
    const withTool = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: ['Bash', TOOL], outputStyle: null, traits: [] } as never)
    expect(withTool.sections.map(s => s.id)).toEqual(['intro', 'next-steps:hint'])
    expect(withTool.sections[1].scope).toBe('session')
    const without = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: ['Bash'], outputStyle: null, traits: [] } as never)
    expect(without.sections.map(s => s.id)).toEqual(['intro'])
  })
})

describe('steps', () => {
  test('cleaned and capped', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ label: `  step\n${i}  `, prompt: `do ${i}` }))
    const s = stepsFrom({ steps: many })
    expect(Array.isArray(s) && s.length).toBe(4)
    expect(Array.isArray(s) && s[0].label).toBe('step 0')
    expect(stepsFrom({ steps: [{ label: 'x'.repeat(60), prompt: 'p' }] })).toEqual([{ label: 'x'.repeat(39) + '…', prompt: 'p' }])
    expect(stepsFrom({ steps: [{ label: 'no prompt' }] })).toBe('each step needs a label and a prompt')
    expect(stepsFrom({})).toBe('steps must be a non-empty list')
  })
})
