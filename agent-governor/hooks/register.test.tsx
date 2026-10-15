import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On, RenderPropsOf } from 'claude-code'

import { DEFAULTS, KEEP_FINISHED_MS, empty, fmtTok, parseCommand, parseCount, prune, reconcile, settingsFrom, spawned } from './govern'

type Opts = { stored?: Record<string, unknown>; answer?: string | 'reject' }

function world(on: On, opts: Opts = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = {
    clock,
    stored: { ...(opts.stored ?? {}) } as Record<string, unknown>,
    toasts: [] as string[],
    asked: [] as string[],
    spawns: [] as { type: string; model?: string }[],
    ran: [] as { tool: string; agentId?: string }[],
    list: [] as AgentInfo[],
    listCalls: 0,
    usage: null as unknown,
    nextId: 1,
  }
  on('session.start', async () => ({ cwd: 'C:/work' }) as never)
  on('command.register', async ($, e) => ({ value: { command: e.name } }) as never)
  on('store.get', async ($, e) => ({ value: w.stored[e.key] }) as never)
  on('store.set', async ($, e) => {
    w.stored[e.key] = e.value
    return { value: undefined } as never
  })
  on('ui.toast', async ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined } as never
  })
  on('agent.list', async () => {
    w.listCalls++
    return { value: w.list } as never
  })
  on('agent.spawn', async ($, e) => {
    w.spawns.push({ type: e.subagentType, model: e.model })
    return { model: e.model ?? 'inherit', agentId: `a${w.nextId++}` } as never
  })
  on('tool.call', async ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      const q = (e as unknown as { questions: { question: string }[] }).questions[0].question
      w.asked.push(q)
      if (opts.answer === 'reject') throw new Error('no one to answer')
      return { result: { questions: (e as never as { questions: unknown }).questions, answers: { [q]: opts.answer ?? 'Deny' } }, text: 'answered' } as never
    }
    w.ran.push({ tool: String(e.tool), agentId: e.agentId })
    return { result: {}, text: 'ok' } as never
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: w.usage } as never
  })
  on('turn.complete', async () => ({ text: '' }) as never)
  // another mod's band row, beneath this one
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['OTHER-MOD-ROW'] }))
  return w
}

type W = ReturnType<typeof world>

const start = ($: Engine) => $.session.start({ source: 'startup', cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
const spawn = ($: Engine, subagentType = 'Explore', model?: string) =>
  $.agent.spawn({ prompt: 'look around', description: `find ${subagentType}`, subagentType, ...(model ? { model } : {}) } as never)
async function spawnN($: Engine, n: number, type = 'Explore') {
  for (let i = 0; i < n; i++) await spawn($, type)
}
async function step($: Engine, w: W, agentId: string | undefined, tokens: number) {
  // cache reads come on top and must not count: `tokens` is what the budget sees
  w.usage = { input_tokens: tokens / 2, output_tokens: tokens / 4, cache_read_input_tokens: tokens * 10, cache_creation_input_tokens: tokens / 4, model: 'claude-sonnet-5-5' }
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 2, ...(agentId ? { agentId } : {}) } as never)
  for await (const _ of s) {
    // drain
  }
  await s.result
}
const complete = ($: Engine, agentId: string) => $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't', agentId, answer: 'done' } as never)
const gov = ($: Engine, args = '') => $.command.run({ command: 'governor', args } as never) as Promise<{ text?: string }>
const call = ($: Engine, agentId?: string) => $.tool.call({ tool: 'Read', file_path: 'C:/work/a.ts', ...(agentId ? { agentId } : {}) } as never)
const band = (hasSurvey = false): RenderPropsOf['AbovePrompt'] =>
  ({ hasSurvey, isWorking: true, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }) as never
const textOf = async (ui: { findAll: (q: object) => Promise<{ text: string }[]> }) => (await ui.findAll({}))[0]?.text ?? ''
const bandText = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal', hasSurvey = false) =>
  textOf(await $.ui.mount({ plugin: 'agent-governor', surface, component: 'AbovePrompt', props: band(hasSurvey) }))

describe('band', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: spawned agents show as a count, stacked above other rows`, async ($, on) => {
      world(on)
      await start($)
      await spawnN($, 3)
      const text = await bandText($, surface)
      expect(text).toContain('[GOV] agents 3 running · peak 3 · 0 tok')
      expect(text).not.toContain('⚠')
      expect(text.indexOf('[GOV]')).toBeLessThan(text.indexOf('OTHER-MOD-ROW'))
    })
  }

  test('hidden when idle, when every agent has finished, and under a survey', async ($, on) => {
    world(on)
    await start($)
    let text = await bandText($)
    expect(text).not.toContain('[GOV]')
    expect(text).toContain('OTHER-MOD-ROW')
    await spawnN($, 2)
    expect(await bandText($, 'terminal', true)).not.toContain('[GOV]')
    await complete($, 'a1')
    expect(await bandText($)).toContain('agents 1 running · peak 2')
    await complete($, 'a2')
    text = await bandText($)
    expect(text).not.toContain('[GOV]')
    expect(text).toContain('OTHER-MOD-ROW')
  })
})

describe('tokens', () => {
  test('turn.step usage adds up per agentId; the main loop is not counted', async ($, on) => {
    const w = world(on)
    await start($)
    await spawnN($, 2)
    await step($, w, 'a1', 24_000)
    await step($, w, 'a1', 24_000)
    await step($, w, 'a2', 8_000)
    await step($, w, undefined, 500_000)
    expect(await bandText($)).toContain('agents 2 running · peak 2 · 56k tok')
    const status = (await gov($)).text ?? ''
    expect(status).toContain('subagent tokens 56k')
    expect(status).toContain('Explore#1  48k  running')
    expect(status).toContain('Explore#2  8k  running')
    expect(status.indexOf('Explore#1')).toBeLessThan(status.indexOf('Explore#2'))
  })

  test('a finished agent steps again (resumed) and counts as running', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($)
    await complete($, 'a1')
    expect(await bandText($)).not.toContain('[GOV]')
    await step($, w, 'a1', 1000)
    expect(await bandText($)).toContain('agents 1 running')
  })
})

describe('warnings (default: watch and warn only)', () => {
  test('more than maxConcurrent running toasts once and blocks nothing', async ($, on) => {
    const w = world(on)
    await start($)
    await spawnN($, 8)
    expect(w.spawns.length).toBe(8)
    expect(w.asked).toEqual([])
    expect(w.toasts).toEqual(['agent-governor: 7 subagents running (limit 6)'])
    expect(await bandText($)).toContain('⚠ 8 > 6 running')
    // drops back under, then crosses again: a second toast
    await complete($, 'a1')
    await complete($, 'a2')
    await spawn($)
    expect(w.toasts.length).toBe(2)
  })

  test('an agent over its budget toasts once, its tool calls still run', async ($, on) => {
    const w = world(on)
    await start($)
    await spawnN($, 2)
    await step($, w, 'a2', 200_000)
    expect(w.toasts).toEqual([])
    await step($, w, 'a2', 180_000)
    await step($, w, 'a2', 8_000)
    expect(w.toasts).toEqual(['agent-governor: Explore#2 used 380k tokens (budget 300k)'])
    expect(await bandText($)).toContain('⚠ Explore#2 388k > 300k')
    await call($, 'a2')
    expect(w.ran).toEqual([{ tool: 'Read', agentId: 'a2' }])
  })

  test('the session budget toasts once', async ($, on) => {
    const w = world(on)
    await start($)
    await gov($, 'session 100k')
    await spawnN($, 2)
    await step($, w, 'a1', 64_000)
    await step($, w, 'a2', 64_000)
    await step($, w, 'a2', 8_000)
    expect(w.toasts).toEqual(['agent-governor: subagents used 128k tokens this session (budget 100k)'])
    expect(await bandText($)).toContain('⚠ session 136k > 100k')
  })
})

describe('caps (opt-in)', () => {
  test('at the limit a spawn asks; Deny refuses it with a message for the model', async ($, on) => {
    const w = world(on, { answer: 'Deny' })
    await start($)
    expect((await gov($, 'caps on')).text).toContain('caps ON')
    await spawnN($, 6)
    expect(w.asked).toEqual([])
    const r = await spawn($)
    expect(w.asked).toEqual(['6 agents already running. Start another?'])
    expect(JSON.stringify(r)).toContain('Wait for the running agents to finish')
    expect(w.spawns.length).toBe(6)
  })

  test('Start it lets it through', async ($, on) => {
    const w = world(on, { answer: 'Start it' })
    await start($)
    await gov($, 'caps on')
    await spawnN($, 7)
    expect(w.asked.length).toBe(1)
    expect(w.spawns.length).toBe(7)
  })

  test('no one to answer: fails closed', async ($, on) => {
    const w = world(on, { answer: 'reject' })
    await start($)
    await gov($, 'caps on')
    await spawnN($, 6)
    const r = await spawn($)
    expect(JSON.stringify(r)).toContain('already running')
    expect(w.spawns.length).toBe(6)
  })

  test('spawns made at once count each other: only the first under the limit starts unasked', async ($, on) => {
    const w = world(on, { answer: 'Deny' })
    await start($)
    await gov($, 'caps on')
    await spawnN($, 5)
    const results = await Promise.all([spawn($), spawn($), spawn($), spawn($)])
    expect(w.spawns.length).toBe(6)
    expect(w.asked.length).toBe(3)
    expect(results.filter(r => JSON.stringify(r).includes('already running')).length).toBe(3)
    expect(await bandText($)).toContain('agents 6 running')
  })

  test('an agent over budget may still hand back, message and stop', async ($, on) => {
    const w = world(on)
    await start($)
    await gov($, 'caps on')
    await spawn($)
    await step($, w, 'a1', 320_000)
    for (const tool of ['SubagentHandback', 'SendMessage', 'TaskStop']) await $.tool.call({ tool, message: 'report', agentId: 'a1' } as never)
    expect(w.ran.map(r => r.tool)).toEqual(['SubagentHandback', 'SendMessage', 'TaskStop'])
    expect(JSON.stringify(await call($, 'a1'))).toContain('used its token budget')
    expect(w.ran.length).toBe(3)
  })

  test('an agent over budget has its tool calls denied; others and the main loop run', async ($, on) => {
    const w = world(on)
    await start($)
    await gov($, 'caps on')
    await spawnN($, 2)
    await step($, w, 'a1', 320_000)
    expect(w.toasts).toEqual(['agent-governor: Explore#1 used 320k tokens (budget 300k); its next tool call is denied'])
    const denied = await call($, 'a1')
    expect(JSON.stringify(denied)).toContain('agent-governor: this agent used its token budget; stop and hand back your findings now.')
    await call($, 'a2')
    await call($)
    expect(w.ran).toEqual([{ tool: 'Read', agentId: 'a2' }, { tool: 'Read', agentId: undefined }])
    await gov($, 'caps off')
    await call($, 'a1')
    expect(w.ran.length).toBe(3)
  })
})

describe('routing (opt-in)', () => {
  test('rewrites the model for that type only when the call gave none', async ($, on) => {
    const w = world(on)
    await start($)
    expect((await gov($, 'route Explore=sonnet')).text).toContain('Explore=sonnet')
    await spawn($, 'Explore')
    await spawn($, 'Explore', 'opus')
    await spawn($, 'Plan')
    await gov($, 'route off')
    await spawn($, 'Explore')
    expect(w.spawns).toEqual([
      { type: 'Explore', model: 'sonnet' },
      { type: 'Explore', model: 'opus' },
      { type: 'Plan', model: undefined },
      { type: 'Explore', model: undefined },
    ])
  })

  test('a model that is not an alias or a claude- id is refused and not kept', async ($, on) => {
    const w = world(on)
    await start($)
    const typo = (await gov($, 'route Explore=sonet')).text ?? ''
    expect(typo).toContain('"sonet" is not a model')
    expect(typo).toContain('sonnet, opus, haiku, fable')
    expect(w.stored.settings).toBeUndefined()
    expect((await gov($, 'route Explore=Sonnet')).text).toContain('Explore=sonnet')
    expect((await gov($, 'route Plan=claude-opus-4-8[1m]')).text).toContain('Plan=claude-opus-4-8[1m]')
    expect((await gov($, 'route Plan=gpt-5')).text).toContain('is not a model')
    expect((w.stored.settings as { routes: unknown }).routes).toEqual({ Explore: 'sonnet', Plan: 'claude-opus-4-8[1m]' })
    await spawn($, 'Explore')
    expect(w.spawns).toEqual([{ type: 'Explore', model: 'sonnet' }])
  })

  test('a bad model stored by an older version is dropped at load', async ($, on) => {
    const w = world(on, { stored: { settings: { routes: { Explore: 'sonet', Plan: 'OPUS' } } } })
    await start($)
    expect((await gov($)).text).toContain('Routes: Plan=opus')
    await spawn($, 'Explore')
    await spawn($, 'Plan')
    expect(w.spawns).toEqual([
      { type: 'Explore', model: undefined },
      { type: 'Plan', model: 'opus' },
    ])
  })
})

describe('settings', () => {
  test('commands persist to the store', async ($, on) => {
    const w = world(on)
    await start($)
    await gov($, 'max 4')
    await gov($, 'budget 200k')
    await gov($, 'session 2m')
    await gov($, 'caps on')
    await gov($, 'route Explore=haiku')
    expect(w.stored.settings).toEqual({ maxConcurrent: 4, agentBudget: 200_000, sessionBudget: 2_000_000, caps: true, routes: { Explore: 'haiku' } })
    expect((await gov($, 'max lots')).text).toContain('positive number')
    expect((await gov($, 'frobnicate')).text).toContain('Unknown /governor command')
  })

  test('stored settings are in force from the start', async ($, on) => {
    const w = world(on, { stored: { settings: { maxConcurrent: 2, agentBudget: 50_000, sessionBudget: 1_000_000, caps: true, routes: { Plan: 'opus' } } }, answer: 'Deny' })
    await start($)
    const status = (await gov($)).text ?? ''
    expect(status).toContain('caps ON')
    expect(status).toContain('Limits: 2 concurrent · 50k per agent · 1M per session')
    expect(status).toContain('Routes: Plan=opus')
    await spawn($, 'Plan')
    await spawn($, 'Plan')
    expect(JSON.stringify(await spawn($, 'Plan'))).toContain('limit 2')
    expect(w.spawns).toEqual([
      { type: 'Plan', model: 'opus' },
      { type: 'Plan', model: 'opus' },
    ])
  })
})

describe('agent.list reconcile', () => {
  test('after tool activity the list corrects finished agents and adopts unseen ones', async ($, on) => {
    const w = world(on)
    await start($)
    await spawnN($, 2)
    await w.clock.advance(1000)
    w.list = [
      { id: 'a1', type: 'Explore', description: 'x', status: 'completed' },
      { id: 'a2', type: 'Explore', description: 'x', status: 'running' },
      { id: 'b9', type: 'Plan', description: 'y', status: 'waiting' },
    ]
    await call($)
    await call($)
    expect(w.listCalls).toBe(0)
    await w.clock.advance(3000)
    expect(w.listCalls).toBe(1) // one ask for the burst
    expect(await bandText($)).toContain('agents 2 running · peak 2')
    expect((await gov($)).text).toContain('Plan#1')
  })

  test('no activity, or nothing running: no list asks', async ($, on) => {
    const w = world(on)
    await start($)
    await call($)
    await w.clock.advance(10_000)
    expect(w.listCalls).toBe(0)
  })
})

describe('helpers', () => {
  test('numbers and commands', async () => {
    expect(parseCount('300k')).toBe(300_000)
    expect(parseCount('3M')).toBe(3_000_000)
    expect(parseCount('1.5m')).toBe(1_500_000)
    expect(parseCount('3_000_000')).toBe(3_000_000)
    expect(parseCount('0')).toBe(null)
    expect(parseCount('-4')).toBe(null)
    expect(fmtTok(412_345)).toBe('412k')
    expect(fmtTok(3_000_000)).toBe('3M')
    expect(fmtTok(3_140_000)).toBe('3.1M')
    expect(fmtTok(950)).toBe('950')
    expect(parseCommand('')).toEqual({ kind: 'status' })
    expect(parseCommand('route Explore=off')).toEqual({ kind: 'route', type: 'Explore', model: null })
    expect(parseCommand('route off')).toEqual({ kind: 'routes-off' })
    expect(parseCommand('caps maybe').kind).toBe('error')
    expect(parseCommand('route Explore=HAIKU')).toEqual({ kind: 'route', type: 'Explore', model: 'haiku' })
    expect(parseCommand('route Explore=sonet').kind).toBe('error')
    expect(settingsFrom({ maxConcurrent: -1, caps: 'yes', routes: { A: 'x', B: 3, C: 'Sonnet' } })).toEqual({ ...DEFAULTS, routes: { C: 'sonnet' } })
  })

  test('finished agents older than an hour are dropped, totals kept', async () => {
    let g = spawned(empty(), { id: 'a', type: 'Explore', description: '' }, 0)
    g = { ...g, sessionTokens: 999, agents: { a: { ...g.agents.a, isRunning: false, endedAt: 10 } } }
    expect(Object.keys(prune(g, 10 + KEEP_FINISHED_MS - 1).agents)).toEqual(['a'])
    const later = prune(g, 11 + KEEP_FINISHED_MS)
    expect(later.agents).toEqual({})
    expect(later.sessionTokens).toBe(999)
    expect(later.spawned).toBe(1)
  })

  test('reconcile defers to events newer than the list', async () => {
    const g = spawned(empty(), { id: 'a', type: 'Explore', description: '' }, 500)
    expect(reconcile(g, [{ id: 'a', type: 'Explore', description: '', status: 'completed' }], 400, 600).agents.a.isRunning).toBe(true)
    expect(reconcile(g, [{ id: 'a', type: 'Explore', description: '', status: 'completed' }], 600, 600).agents.a.isRunning).toBe(false)
  })
})
