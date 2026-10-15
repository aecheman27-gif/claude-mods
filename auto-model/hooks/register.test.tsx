import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On, RenderPropsOf } from 'claude-code'

import { decide, inputCost, tierOf } from './register'

const HOUR = 3_600_000
const NOW = 10 * HOUR

type World = {
  toasts: string[]
  steps: { model: string; effort: unknown; agentId?: string }[]
  submitted: string[]
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
}

function world(on: On, opts: { tokens?: number } = {}): World {
  const w: World = { toasts: [], steps: [], submitted: [], store: new Map(), clock: mock.clock(on, { now: NOW }) }
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
  const OPUS = 'claude-opus-5-5'
  const warm = NOW - 10 * 60_000
  const cold = NOW - 2 * HOUR
  const cache = (lastUsed: Record<string, number>, tokens = 30_000) => ({ tokens, now: NOW, lastUsed, haikuLimit: 75_000, opusLimit: 50_000 })

  test('input cost per request: warm reads, cold 1-hour writes, Haiku by its own count and tier', async () => {
    const cents = (n: number) => Math.round(n * 1000) / 10
    expect(cents(inputCost('opus', 60_000, true))).toBe(1.2)
    expect(cents(inputCost('haiku', 60_000, false))).toBe(1.6)
    expect(cents(inputCost('sonnet', 60_000, false))).toBe(24)
    expect(cents(inputCost('opus', 200_000, true))).toBe(4)
    expect(cents(inputCost('haiku', 200_000, false))).toBe(26)
  })

  test('Haiku while it is cheap: under its limit, or its cache is warm, or yours went cold', async () => {
    const d = decide('quick', OPUS, cache({ opus: warm }))
    expect(d.family).toBe('haiku')
    expect(d.note).toContain('under 75k tokens a Haiku re-read costs about what staying does (input ≈ $0.008 vs $0.006 staying)')
    const held = decide('quick', OPUS, cache({ opus: warm }, 120_000))
    expect(held.family).toBeUndefined()
    expect(held.note).toContain('kept opus: the context (120k) is past the 75k limit for haiku')
    expect(decide('quick', OPUS, cache({ opus: warm, haiku: warm }, 120_000)).note).toContain("haiku's cache is still warm")
    expect(decide('quick', OPUS, cache({ opus: cold }, 120_000)).family).toBe('haiku')
  })

  test('Sonnet waits while your cache is warm; a new session or a cold cache lets it go', async () => {
    const held = decide('medium', OPUS, cache({ opus: warm }))
    expect(held.family).toBeUndefined()
    expect(held.note).toContain('Sonnet would re-read the chat cold (input ≈ $0.12 vs $0.006 staying)')
    expect(decide('medium', OPUS, cache({ opus: cold })).note).toContain("opus's cache was cold too")
    expect(decide('medium', OPUS, cache({})).family).toBe('sonnet')
  })

  test('Opus from a cheaper session under its limit; Fable and the right fit are kept', async () => {
    expect(decide('heavy', 'claude-sonnet-5-5', cache({ sonnet: warm })).family).toBe('opus')
    expect(decide('heavy', 'claude-sonnet-5-5', cache({ sonnet: warm }, 80_000)).family).toBeUndefined()
    expect(decide('heavy', OPUS, cache({})).note).toBe('kept opus, the right fit')
    expect(decide('quick', 'claude-fable-5-1', cache({}))).toEqual({ note: 'kept fable: your own pick' })
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

  test('a long chat on a warm Opus cache keeps Opus and says why', async ($, on) => {
    const w = world(on, { tokens: 180_000 })
    await start($)
    await turn($, 'fix the failing flightdeck test', 'T1')
    await w.clock.advance(5 * 60_000)
    await turn($, 'how many unread emails are in my Gmail right now', 'T2')
    expect(w.steps.every(s => s.model === 'claude-opus-5-5')).toBe(true)
    expect(w.toasts).toEqual([])
    const status = (await run($, 'status')).text
    expect(status).toContain('Caches this session: opus warm (used 0m ago).')
    expect(status).toContain('Last prompt: kept opus: the context (180k) is past the 75k limit for haiku (input ≈ $0.23 vs $0.036 staying).')
  })

  test('Sonnet waits while Opus is warm, and goes once an hour idle has let it cool', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, 'fix the failing flightdeck test', 'T1')
    await turn($, 'explain what the cache-tax mod does', 'T2')
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
    expect(w.toasts).toEqual([])
    await w.clock.advance(HOUR + 60_000)
    await turn($, 'explain what the cache-tax mod does', 'T3')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    expect(w.toasts).toEqual(['auto-model: sonnet for this one ("explain"). /automodel off to stop'])
    expect((await run($, 'status')).text).toContain("Last prompt: sonnet instead of opus: opus's cache was cold too")
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
