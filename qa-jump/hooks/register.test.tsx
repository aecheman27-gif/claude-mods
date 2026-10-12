import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { targetOf } from './register'

function world(on: On) {
  const w = { toasts: [] as string[], opened: [] as string[] }
  on('session.start', async () => ({ cwd: 'C:/work' }) as never)
  on('command.register', async ($, e) => ({ value: { command: e.name } }) as never)
  on('ui.panes', async () => ({ value: [] }) as never)
  on('ui.open', async ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.toast', async ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined } as never
  })
  return w
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
const text = (t: string) => [{ type: 'text', text: t }]
const ask = ($: Engine, uuid: string, t: string, kind = 'composer', extra: object = {}) =>
  $.session.append({ uuid, door: 'prompt', origin: { kind }, message: { type: 'user', role: 'user', content: text(t), ...extra } } as never)
const reply = ($: Engine, uuid: string, content: unknown[], agentId?: string) =>
  $.session.append({ uuid, door: 'response', origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content }, ...(agentId ? { agentId } : {}) } as never)
const toolUse = [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]
const pane: RenderPropsOf['Pane'] = { title: 'Questions', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never
const mountPane = ($: Engine) => $.ui.mount({ plugin: 'qa-jump', surface: 'terminal', component: 'Pane', requestId: 'qa', props: pane } as never)
const textOf = async (ui: { findAll: (q: object) => Promise<{ text: string }[]> }) => (await ui.findAll({}))[0]?.text ?? ''

describe('questions', () => {
  test('questions pair with their answers, newest first; rows are stored unchanged', async ($, on) => {
    world(on)
    await start($)
    const kept = await ask($, 'u1', 'What is /arcade and how do I use it?')
    expect(JSON.stringify(kept)).not.toContain('qa-jump')
    await reply($, 'a1', text('Let me check the README.'))
    await reply($, 'a2', toolUse)
    await reply($, 'a3', text('`/arcade` comes from **cc-arcade**, a mod that puts games above the prompt.'))
    await ask($, 'u2', 'make me a bat file')
    await reply($, 'a4', text('I put Claude.bat on your desktop.'))
    const t = await textOf(await mountPane($))
    expect(t.indexOf('make me a bat file')).toBeLessThan(t.indexOf('What is /arcade'))
    expect(t).toContain('↳ I put Claude.bat on your desktop.')
    expect(t).toContain('↳ /arcade comes from cc-arcade, a mod that puts games above the prompt.')
  })

  test('answer lands on the last reply row with text; ask on the question', async () => {
    const x = { n: 1, id: 'u1', question: 'q', firstAnswerId: 'a1', answerId: 'a3', preview: 'p' }
    expect(targetOf(x, 'answer')).toBe('a3')
    expect(targetOf(x, 'ask')).toBe('u1')
    expect(targetOf({ n: 1, id: 'u1', question: 'q', firstAnswerId: 'a1' }, 'answer')).toBe('a1')
    expect(targetOf({ n: 1, id: 'u1', question: 'q' }, 'answer')).toBeUndefined()
  })

  test('the newest text row is the answer; tool-only rows just mark it under way', async ($, on) => {
    world(on)
    await start($)
    await ask($, 'u1', 'why did the test fail?')
    await reply($, 'a1', toolUse)
    const ui = await mountPane($)
    expect(await textOf(ui)).toContain('working…')
    await reply($, 'a2', text('Reading the log.'))
    await reply($, 'a3', text('The fixture path was wrong.'))
    await reply($, 'a4', toolUse)
    const t = await textOf(ui)
    expect(t).toContain('↳ The fixture path was wrong.')
    expect(t).toContain('answer')
  })

  test('a press tries to scroll and says so when it cannot', async ($, on) => {
    const w = world(on)
    await start($)
    await ask($, 'u1', 'hello there')
    await reply($, 'a1', text('Hi!'))
    const ui = await mountPane($)
    await ui.press({ key: 'a-1' })
    await ui.press({ key: 'q-1' })
    expect(w.toasts.length).toBe(2)
    expect(w.toasts[0]).toContain("qa-jump: couldn't scroll there")
  })

  test('slash commands, plugin prompts, hidden rows and subagent replies are skipped', async ($, on) => {
    world(on)
    await start($)
    await ask($, 'u1', '/arcade list')
    await ask($, 'u2', 'Run the tests', 'plugin')
    await ask($, 'u3', 'a reminder', 'composer', { isMeta: true })
    await ask($, 'u4', 'real question?')
    await reply($, 'a1', text('A subagent talking.'), 'agent-1')
    const t = await textOf(await mountPane($))
    expect(t).not.toContain('/arcade')
    expect(t).not.toContain('Run the tests')
    expect(t).not.toContain('a reminder')
    expect(t).not.toContain('subagent')
    expect(t).toMatch(/ 1\s*real question\?/)
    expect(t).toContain('no answer yet')
  })

  test('a prompt nobody typed closes the question: replies to it are not its answer', async ($, on) => {
    world(on)
    await start($)
    await ask($, 'u1', 'why did the build break?')
    await reply($, 'a1', text('A missing import in app.ts.'))
    await ask($, 'n1', '<task-notification>background build finished</task-notification>', 'task-notification')
    await reply($, 'a2', text('The background build passed.'))
    await reply($, 'a3', toolUse)
    const ui = await mountPane($)
    const t = await textOf(ui)
    expect(t).toContain('↳ A missing import in app.ts.')
    expect(t).not.toContain('background build')
    expect(t).toMatch(/ 1\s*why did the build break\?/)
    await ask($, 'u2', 'and now?')
    await reply($, 'a4', text('Now it builds.'))
    expect(await textOf(ui)).toContain('↳ Now it builds.')
  })

  test('/qa opens the pane', async ($, on) => {
    const w = world(on)
    await start($)
    await $.command.run({ command: 'qa', args: '' } as never)
    expect(w.opened).toEqual(['qa'])
  })
})
