import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On, RenderPropsOf } from 'claude-code'

import { decide, tierOf } from './register'

type World = {
  toasts: string[]
  steps: { model: string; effort: unknown; agentId?: string }[]
  submitted: string[]
  store: Map<string, unknown>
}

function world(on: On, opts: { tokens?: number } = {}): World {
  const w: World = { toasts: [], steps: [], submitted: [], store: new Map() }
  on('session.start', async () => ({ cwd: 'C:/work' }) as never)
  on('command.register', async ($, e) => ({ value: { command: e.name } }) as never)
  on('store.get', async ($, e) => ({ value: w.store.get(e.key) }) as never)
  on('store.set', async ($, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('ui.toast', async ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.status', async () => ({ value: undefined }) as never)
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: opts.tokens ?? 30_000 }, rateLimits: [] } }) as never)
  on('prompt.submit', async ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text } as never
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    w.steps.push({ model: e.model, effort: e.effort, agentId: e.agentId })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  on('turn.complete', async () => ({ text: '' }) as never)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['OTHER-MOD-ROW'] }))
  return w
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
async function step($: Engine, turnId: string, model: string, index = 0, agentId?: string) {
  const s = $.turn.step({ turnId, index, model, effort: 'xhigh', messageCount: 2, ...(agentId ? { agentId } : {}) } as never)
  for await (const _ of s) {
    // drain
  }
  await s.result
}
/** One prompt as the person sends it: submitted, its turn started, two requests, done. */
async function turn($: Engine, text: string, turnId: string, model = 'claude-opus-5-5', kind = 'composer') {
  await $.prompt.submit({ text, origin: { kind }, wait: false } as never)
  await $.turn.start({ text, turnId })
  await step($, turnId, model, 0)
  await step($, turnId, model, 1)
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId, answer: 'done', durationMs: 1000 } as never)
}
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'automodel', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as CommandRunInput)
const band: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} } as never
const mount = ($: Engine) => $.ui.mount({ plugin: 'auto-model', surface: 'terminal', component: 'AbovePrompt', props: band })
const textOf = async (ui: { findAll: (q: object) => Promise<{ text: string }[]> }) => (await ui.findAll({}))[0]?.text ?? ''

describe('tierOf', () => {
  test('the video examples and everyday prompts', async () => {
    expect(tierOf('how many unread emails are in my Gmail right now').tier).toBe('quick')
    expect(tierOf('build me a weather dashboard for New York City')).toEqual({ tier: 'heavy', why: '"build"' })
    expect(tierOf('is my github connected?').tier).toBe('quick')
    expect(tierOf('Explain what the cache-tax mod does').tier).toBe('medium')
    expect(tierOf('draft an email to my landlord about the leak').tier).toBe('medium')
    expect(tierOf('write a script that renames my photos').tier).toBe('heavy')
    expect(tierOf('fix the failing flightdeck test').tier).toBe('heavy')
    expect(tierOf('what is this?', true)).toEqual({ tier: 'heavy', why: 'has an attachment' })
  })

  test('follow-ups and plain requests stay on the session model', async () => {
    for (const t of ['yes', 'Push it now', 'Delete the old claude-mods-history repo now', 'Please make it where there is zero risk and it is public'])
      expect(tierOf(t).tier).toBe('keep')
  })

  test('words inside other words do not count', async () => {
    expect(tierOf('what is the latest version?').tier).toBe('quick') // "latest" is not "test"
    expect(tierOf('show me the report').tier).toBe('quick') // "report" is not "port"
  })
})

describe('decide', () => {
  test('switches only to another family, under the limit, never from Fable', async () => {
    expect(decide('quick', 'claude-opus-5-5', 30_000, 50_000)).toEqual({ family: 'haiku', note: 'haiku instead of opus' })
    expect(decide('heavy', 'claude-opus-5-5', 30_000, 50_000).family).toBeUndefined()
    expect(decide('heavy', 'claude-sonnet-5-5', 30_000, 50_000).family).toBe('opus')
    expect(decide('quick', 'claude-fable-5-1', 0, 50_000)).toEqual({ note: 'kept fable: your own pick' })
    const held = decide('quick', 'claude-opus-5-5', 120_000, 50_000)
    expect(held.family).toBeUndefined()
    expect(held.note).toContain('past the 50k switch limit')
  })
})

describe('routing a turn', () => {
  test('a quick question runs every request of its turn on Haiku, then offers Redo', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, 'how many unread emails are in my Gmail right now', 'T1')
    expect(w.steps.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5'])
    expect(w.steps.every(s => s.effort === undefined)).toBe(true)
    expect(w.toasts).toEqual(['auto-model: haiku for this one (quick question). /automodel off to stop'])
    const ui = await mount($)
    const text = await textOf(ui)
    expect(text).toContain('[AUTO] haiku answered that (quick question).')
    expect(text).toContain('Redo with opus')
    expect(text.indexOf('[AUTO]')).toBeLessThan(text.indexOf('OTHER-MOD-ROW'))
    // Redo sends the same prompt again, which runs on the session's own model
    await ui.press({ key: 'redo' })
    expect(w.submitted.at(-1)).toBe('how many unread emails are in my Gmail right now')
    expect(await textOf(ui)).not.toContain('[AUTO]')
    await $.turn.start({ text: 'how many unread emails are in my Gmail right now', turnId: 'T2' })
    await step($, 'T2', 'claude-opus-5-5')
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test('a heavy prompt on Opus and a follow-up are left alone, with no toast or row', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, 'build me a weather dashboard for New York City', 'T1')
    await turn($, 'yes, go ahead', 'T2')
    expect(w.steps.map(s => [s.model, s.effort])).toEqual(Array(4).fill(['claude-opus-5-5', 'xhigh']))
    expect(w.toasts).toEqual([])
    expect(await textOf(await mount($))).not.toContain('[AUTO]')
  })

  test('past the context limit it keeps the session model and says why', async ($, on) => {
    const w = world(on, { tokens: 180_000 })
    await start($)
    await turn($, 'how many unread emails are in my Gmail right now', 'T1')
    expect(w.steps.every(s => s.model === 'claude-opus-5-5')).toBe(true)
    expect(w.toasts).toEqual([])
    expect((await run($, 'status')).text).toContain('Last prompt: kept opus: the context (180k) is past the 50k switch limit')
  })

  test('subagents, Fable sessions, peers and /automodel off are never rerouted', async ($, on) => {
    const w = world(on)
    await start($)
    await $.prompt.submit({ text: 'what time is it?', origin: { kind: 'composer' }, wait: false } as never)
    await $.turn.start({ text: 'what time is it?', turnId: 'T1' })
    await step($, 'T1', 'claude-sonnet-5-5', 0, 'agent-1')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    await turn($, 'what time is it?', 'T2', 'claude-fable-5-1')
    expect(w.steps.at(-1)?.model).toBe('claude-fable-5-1')
    await turn($, 'what time is it?', 'T3', 'claude-opus-5-5', 'peer')
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
    expect((await run($, 'off')).text).toContain('auto-model is off')
    await turn($, 'what time is it?', 'T4')
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
    await run($, 'on')
    await turn($, 'what time is it?', 'T5')
    expect(w.steps.at(-1)?.model).toBe('claude-haiku-5-5')
  })

  test('a new prompt clears the row', async ($, on) => {
    world(on)
    await start($)
    await turn($, 'what time is it?', 'T1')
    const ui = await mount($)
    expect(await textOf(ui)).toContain('[AUTO]')
    await $.prompt.submit({ text: 'thanks', origin: { kind: 'composer' }, wait: false } as never)
    expect(await textOf(ui)).not.toContain('[AUTO]')
  })
})
