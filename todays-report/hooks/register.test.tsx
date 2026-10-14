import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On, RenderPropsOf } from 'claude-code'

import type { Day } from '../types'
import { dayKey, dayOf, kindOf, mainKind, summarize } from './register'

const NOW = new Date(2026, 9, 14, 15, 0).getTime() // 14 Oct 2026, 3pm local
const TODAY = '2026-10-14'
const USAGE = (model: string) => ({ model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 })
const day = (tasks: number, extra: Partial<Day> = {}): Day => ({ ...dayOf(undefined), tasks, ...extra })

type World = { store: Map<string, unknown>; usd: number; opened: string[] }

function world(on: On): World {
  mock.clock(on, { now: NOW })
  const w: World = { store: new Map(), usd: 1, opened: [] }
  on('session.start', async () => ({ cwd: 'C:/work' }) as never)
  on('command.register', async ($, e) => ({ value: { command: e.name } }) as never)
  on('store.get', async ($, e) => ({ value: w.store.get(e.key) }) as never)
  on('store.set', async ($, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: [...w.store.keys()] }) as never)
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: w.usd } } }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }) as never)
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('ui.open', async ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', async () => ({ value: undefined }) as never)
  return w
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
/** One main turn: its tool calls, the cost rising by `spent`, then its end. */
async function task($: Engine, w: World, id: string, tools: [string, Record<string, unknown>][], opts: { spent?: number; model?: string; reason?: string; ms?: number } = {}) {
  await $.turn.start({ text: 'go', turnId: id })
  for (const [tool, input] of tools) await $.tool.call({ tool, ...input } as never)
  w.usd += opts.spent ?? 0.25
  await $.turn.complete({ reason: opts.reason ?? 'answer', isAborted: opts.reason === 'aborted', turnId: id, answer: 'done', durationMs: opts.ms ?? 120_000, usage: USAGE(opts.model ?? 'claude-opus-5-5') } as never)
}
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'report', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as CommandRunInput)
const pane: RenderPropsOf['Pane'] = { title: "Today's report", isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never
const mount = ($: Engine) => $.ui.mount({ plugin: 'todays-report', surface: 'terminal', component: 'Pane', requestId: 'todays-report', props: pane })
const textOf = async (ui: Awaited<ReturnType<typeof mount>>) => (await ui.findAll({})).map(x => x.text).join('\n')

describe('kinds', () => {
  test('each tool call has a kind; a task takes its most telling one', async () => {
    expect(kindOf('mcp__claude_ai_Gmail__search_threads')).toBe('email')
    expect(kindOf('mcp__claude_ai_Google_Calendar__list_events')).toBe('calendar')
    expect(kindOf('Edit', { file_path: 'C:/work/app/main.ts' })).toBe('code')
    expect(kindOf('Write', { file_path: 'C:/work/notes/plan.md' })).toBe('docs')
    expect(kindOf('WebSearch')).toBe('research')
    expect(kindOf('PowerShell')).toBe('commands')
    expect(kindOf('Grep')).toBe('reading')
    expect(kindOf('mcp__claude_ai_Figma__get_screenshot')).toBe('design')
    expect(mainKind({ reading: 12, code: 1 })).toBe('code')
    expect(mainKind({ email: 1, code: 3 })).toBe('email')
    expect(mainKind({})).toBe('chat')
  })
})

describe('summarize', () => {
  test('periods add up the days inside them; the streak runs back from today', async () => {
    const days: Record<string, Day> = {
      '2026-10-14': day(3, { workMs: 600_000, usd: 1.5, kinds: { code: 2, email: 1 }, models: { opus: 3 } }),
      '2026-10-13': day(2, { kinds: { email: 2 }, models: { haiku: 2 } }),
      '2026-10-12': day(1),
      '2026-10-01': day(4),
      '2026-09-01': day(5),
      '2025-01-01': day(9),
    }
    const today = summarize(days, 'today', TODAY)
    expect([today.tasks, today.workMs, today.usd, today.activeDays]).toEqual([3, 600_000, 1.5, 1])
    expect(today.kinds).toEqual({ code: 2, email: 1 })
    expect(summarize(days, 'week', TODAY).tasks).toBe(6)
    expect(summarize(days, 'week', TODAY).models).toEqual({ opus: 3, haiku: 2 })
    expect(summarize(days, 'month', TODAY).tasks).toBe(10)
    expect(summarize(days, 'year', TODAY).tasks).toBe(15)
    expect(summarize(days, 'all', TODAY).tasks).toBe(24)
    expect(today.streak).toBe(3)
    expect(today.best).toBe(3)
    expect(today.since).toBe('2025-01-01')
  })

  test('before today’s first task the streak still counts through yesterday', async () => {
    const r = summarize({ '2026-10-13': day(1), '2026-10-12': day(1) }, 'today', TODAY)
    expect([r.tasks, r.streak]).toEqual([0, 2])
    expect(summarize({ '2026-10-12': day(1) }, 'today', TODAY).streak).toBe(0)
  })

  test('a stored day that is missing fields or holds junk reads as zeros', async () => {
    expect(dayOf({ tasks: 2, usd: 'x', kinds: { code: 1, docs: 'y' } })).toEqual(day(2, { kinds: { code: 1, docs: 0 } }))
    expect(dayKey(NOW)).toBe(TODAY)
  })
})

describe('recording', () => {
  test('answered main turns are tasks; subagents add tokens; an interrupted turn adds only cost', async ($, on) => {
    const w = world(on)
    await start($)
    await task($, w, 'T1', [['Read', { file_path: 'a.ts' }], ['mcp__claude_ai_Gmail__search_threads', {}], ['Edit', { file_path: 'a.ts' }]])
    await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 'S1', agentId: 'agent-1', answer: 'report', durationMs: 5000, usage: USAGE('claude-haiku-5-5') } as never)
    await task($, w, 'T2', [], { model: 'claude-haiku-5-5', ms: 30_000 })
    await task($, w, 'T3', [['Bash', { command: 'npm test' }]], { reason: 'aborted', spent: 0.1 })
    const d = dayOf(w.store.get(`day:${TODAY}`))
    expect(d.tasks).toBe(2)
    expect(d.workMs).toBe(150_000)
    expect(Math.round(d.usd * 100)).toBe(60)
    expect(d.kinds).toEqual({ email: 1, chat: 1 })
    expect(d.models).toEqual({ opus: 1, haiku: 1 })
    // 4 turns' usage: T1, the subagent, T2, T3
    expect([d.tokensIn, d.cachedIn, d.tokensOut]).toEqual([40_000, 36_000, 2000])
  })
})

describe('the pane', () => {
  test('/report shows today with estimates from the settings; the period buttons switch', async ($, on) => {
    const w = world(on)
    w.store.set('day:2026-10-10', day(7, { kinds: { research: 7 }, models: { sonnet: 7 } }))
    await start($)
    await task($, w, 'T1', [['mcp__claude_ai_Gmail__search_threads', {}]], { ms: 90_000 })
    await task($, w, 'T2', [['Edit', { file_path: 'main.ts' }]], { ms: 90_000 })
    expect((await run($, '')).text).toBe('Today: 2 tasks, Claude worked 3m.')
    expect(w.opened).toEqual(['todays-report'])
    const ui = await mount($)
    let text = await textOf(ui)
    expect(text).toContain('Today: 2 tasks · Claude worked 3m')
    expect(text).toContain('Streak: 1 day (best 1)')
    expect(text).toContain('Time saved (estimate): 0.3 h = 2 tasks × 10 min · worth $16.67 at $50.00/h')
    expect(text).toContain('API-equivalent cost: $0.50')
    expect(text).toContain('Email')
    expect(text).not.toContain('Research')
    await ui.press({ key: 'p-week' })
    text = await textOf(ui)
    expect(text).toContain('Last 7 days: 9 tasks')
    expect(text).toContain('on 2 days')
    expect(text).toContain('Research')
    expect(text).toContain('sonnet')
    // a finished task refreshes the open pane
    await task($, w, 'T3', [])
    expect(await textOf(ui)).toContain('Last 7 days: 10 tasks')
  })

  test('an unknown period says how to ask', async ($, on) => {
    world(on)
    await start($)
    expect((await run($, 'decade')).text).toBe('Usage: /report [today | week | month | year | all]')
  })
})
