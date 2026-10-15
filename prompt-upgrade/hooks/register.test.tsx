import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On, RenderPropsOf } from 'claude-code'

import { cleanReply, parseQuestions, writeRequest } from './register'

declare function setTimeout(fn: () => void, ms: number): unknown

const PIZZA = 'Build me a 30-day marketing plan for a pizza company'
const QUESTIONS = JSON.stringify({
  questions: [
    { q: 'What is the main goal of this plan?', options: ['More online orders', 'More dine-in visits', 'Brand awareness'] },
    { q: 'What kind of pizza business is it?', options: ['Single shop', 'Small multi-location', 'Franchise'] },
    { q: 'What is the monthly marketing budget?', options: ['Under $500', '$500-$2,000', 'Over $2,000'] },
  ],
})
const UPGRADED = 'Create a 30-day marketing plan for a small multi-location pizza business whose main goal is more online orders.'

type World = {
  asks: { system: string; prompt: string; model: string }[]
  replies: unknown[]
  opened: string[]
  closed: string[]
  submitted: { text: string; asUser?: boolean }[]
  filled: string[]
  copied: string[]
  toasts: string[]
}

function world(on: On, replies: unknown[]): World {
  const w: World = { asks: [], replies, opened: [], closed: [], submitted: [], filled: [], copied: [], toasts: [] }
  on('session.start', async () => ({ cwd: 'C:/work' }) as never)
  on('command.register', async ($, e) => ({ value: { command: e.name } }) as never)
  on('model.complete', async ($, e) => {
    w.asks.push({ system: String(e.system), prompt: String(e.prompt), model: e.model })
    return { value: w.replies.shift() ?? { isAnswered: false, reason: 'empty-reply' } } as never
  })
  on('ui.open', async ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', async ($, e) => {
    w.closed.push(e.id)
    return { value: undefined } as never
  })
  on('prompt.submit', async ($, e) => {
    w.submitted.push({ text: e.text, asUser: (e.origin as { asUser?: boolean }).asUser })
    return { text: e.text } as never
  })
  on('prompt.fill', async ($, e) => {
    w.filled.push(e.text)
    return { isFilled: true } as never
  })
  on('ui.copy', async ($, e) => {
    w.copied.push(e.text)
    return { value: { isCopied: true } } as never
  })
  on('ui.toast', async ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined } as never
  })
  on('session.messages', async () => ({
    value: [
      { role: 'user', text: 'plan a birthday party for my kid', toolUses: [] },
      { role: 'assistant', text: 'Sure.', toolUses: [] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'x', text: 'ok' }] },
      // rows in the person's role they never typed
      { role: 'user', text: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>', toolUses: [] },
      { role: 'user', text: '<system-reminder>The date changed.</system-reminder>', toolUses: [] },
      { role: 'user', text: '[Request interrupted by user]', toolUses: [] },
    ],
  }) as never)
  return w
}

const answer = (text: string) => ({ isAnswered: true, text, usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
const start = ($: Engine) => $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
const upgrade = ($: Engine, args: string) =>
  $.command.run({ command: 'improve', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as CommandRunInput)
const pane = (columns: number): RenderPropsOf['Pane'] =>
  ({ title: 'Prompt upgrade', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }) as never
const mount = ($: Engine, columns = 120) => $.ui.mount({ plugin: 'prompt-upgrade', surface: 'terminal', component: 'Pane', requestId: 'prompt-upgrade', props: pane(columns) })
type Mounted = Awaited<ReturnType<typeof mount>>
const textOf = async (ui: Mounted) => (await ui.findAll({})).map(x => x.text).join('\n')
/** The model calls run behind the command: wait until the pane shows `want`. */
async function until(ui: Mounted, want: string) {
  for (let i = 0; i < 200; i++) {
    if ((await textOf(ui)).includes(want)) return
    await new Promise<void>(r => setTimeout(r, 5))
  }
  throw new Error(`the pane never showed ${JSON.stringify(want)}:\n${await textOf(ui)}`)
}

describe('parsing', () => {
  test('questions from plain or fenced JSON; junk and one-option questions give none', async () => {
    const qs = parseQuestions(QUESTIONS)
    expect(qs.map(q => q.id)).toEqual(['q1', 'q2', 'q3'])
    expect(qs[0]?.options).toEqual(['More online orders', 'More dine-in visits', 'Brand awareness'])
    expect(parseQuestions('```json\n' + QUESTIONS + '\n```')).toHaveLength(3)
    expect(parseQuestions('Sure! Here are some questions.')).toEqual([])
    expect(parseQuestions('{"questions":[{"q":"Pick one","options":["only"]}]}')).toEqual([])
    const many = { questions: Array.from({ length: 6 }, (_, i) => ({ q: `Q${i}`, options: ['a', 'b', 'a'] })) }
    const capped = parseQuestions(JSON.stringify(many))
    expect(capped).toHaveLength(4)
    expect(capped[0]?.options).toEqual(['a', 'b'])
  })

  test('the rewrite reads only answered questions; replies lose fences and quotes', async () => {
    const questions = parseQuestions(QUESTIONS)
    const req = writeRequest({ original: PIZZA, questions, answers: { q1: 'More online orders', q2: '' }, extra: 'we deliver until 2am' })
    expect(req).toContain(`Request:\n${PIZZA}`)
    expect(req).toContain('- What is the main goal of this plan? More online orders')
    expect(req).not.toContain('What kind of pizza business')
    expect(req).toContain('- Also: we deliver until 2am')
    expect(cleanReply('```\nDo the thing.\n```')).toBe('Do the thing.')
    expect(cleanReply('"Do the thing."')).toBe('Do the thing.')
  })
})

describe('the pane', () => {
  test('questions, picks, the upgraded prompt side by side, then Run sends it', async ($, on) => {
    const w = world(on, [answer(QUESTIONS), answer(UPGRADED)])
    await start($)
    expect((await upgrade($, PIZZA)).text).toContain('reading your prompt')
    expect(w.opened).toEqual(['prompt-upgrade'])
    const ui = await mount($)
    await until(ui, 'What is the main goal of this plan?')
    expect(w.asks[0]).toEqual(expect.objectContaining({ model: 'sonnet', prompt: PIZZA }))
    expect(await textOf(ui)).toContain(`You typed\n${PIZZA}`)
    await ui.press({ key: 'q1-0' })
    await ui.press({ key: 'q2-1' })
    await ui.input({ key: 'extra', text: 'we deliver until 2am' })
    await ui.press({ key: 'write' })
    await until(ui, 'Upgraded')
    expect(w.asks[1]?.prompt).toContain('- What kind of pizza business is it? Small multi-location')
    expect(w.asks[1]?.prompt).toContain('- Also: we deliver until 2am')
    expect(w.asks[1]?.prompt).not.toContain('marketing budget')
    expect(await textOf(ui)).toContain(UPGRADED)
    await ui.press({ key: 'run' })
    for (let i = 0; i < 50 && w.submitted.length === 0; i++) await new Promise<void>(r => setTimeout(r, 5))
    expect(w.closed).toEqual(['prompt-upgrade'])
    // the person read it in the pane: it runs as their own prompt
    expect(w.submitted).toEqual([{ text: UPGRADED, asUser: true }])
  })

  test('a specific prompt goes straight to the rewrite; Edit first fills the box; Copy copies', async ($, on) => {
    const w = world(on, [answer('{"questions":[]}'), answer(UPGRADED)])
    await start($)
    await upgrade($, PIZZA)
    const ui = await mount($, 60)
    // no questions: straight to the rewrite
    await until(ui, 'Upgraded')
    expect(w.asks).toHaveLength(2)
    const shown = await textOf(ui)
    expect(shown).toContain(`You typed\n${PIZZA}`)
    expect(shown).toContain(`Upgraded\n${UPGRADED}`)
    await ui.press({ key: 'copy' })
    expect(w.copied).toEqual([UPGRADED])
    await ui.press({ key: 'edit' })
    for (let i = 0; i < 50 && w.closed.length === 0; i++) await new Promise<void>(r => setTimeout(r, 5))
    expect(w.filled).toEqual([UPGRADED])
    expect(w.closed).toEqual(['prompt-upgrade'])
    expect(w.submitted).toEqual([])
  })

  test('with no text it takes the last prompt; a failed call offers Try again', async ($, on) => {
    const w = world(on, [{ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error' }, answer(QUESTIONS)])
    await start($)
    expect((await upgrade($, '')).text).toContain('reading your last prompt')
    const ui = await mount($)
    await until(ui, "Couldn't upgrade it: the API answered with an error (529).")
    expect(w.asks[0]?.prompt).toBe('plan a birthday party for my kid')
    await ui.press({ key: 'retry' })
    await until(ui, 'What is the main goal of this plan?')
  })

  test('closing the pane mid-call drops the reply', async ($, on) => {
    const w = world(on, [answer(QUESTIONS)])
    await start($)
    await upgrade($, PIZZA)
    const ui = await mount($)
    await ui.press({ key: 'cancel' })
    for (let i = 0; i < 20; i++) await new Promise<void>(r => setTimeout(r, 5))
    expect(w.closed).toEqual(['prompt-upgrade'])
    expect(await textOf(ui)).toContain('Nothing to upgrade')
  })
})
