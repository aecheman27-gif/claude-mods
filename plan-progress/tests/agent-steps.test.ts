// Modified for my-claude-mods: per-agent steps (TodoWrite, progress_step, the spawn line, the pill's share) against
// the engine itself; tests/regress.mjs has the offline cases, the terminal strip text included
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLAN = 'mcp__plan-progress__plan_progress'
const STEP = 'mcp__plan-progress__progress_step'

function world(on: On) {
  mock.clock(on, { now: 1_000_000 })
  const w = { tools: [] as string[], prompts: [] as string[], stored: {} as Record<string, unknown>, spawns: 0 }
  on('session.start', async () => ({ cwd: 'C:/work' }) as never)
  on('session.id', async () => ({ value: 'session-1' }) as never)
  on('tool.register', async ($, e) => {
    w.tools.push(e.name)
    return { value: undefined } as never
  })
  on('command.register', async ($, e) => ({ value: { command: e.name } }) as never)
  on('config.list', async () => ({ value: [] }) as never)
  on('store.get', async ($, e) => ({ value: w.stored[e.key] }) as never)
  on('store.set', async ($, e) => {
    w.stored[e.key] = e.value
    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: Object.keys(w.stored) }) as never)
  on('agent.spawn', async ($, e) => {
    w.prompts.push(e.prompt)
    return { agentId: `ag${++w.spawns}`, model: 'claude-haiku-4-5' } as never
  })
  on('tool.call', async () => ({ result: {}, text: 'ok' }) as never)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['BELOW'] }))
  return w
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
const plan = ($: Engine) =>
  $.tool.call({ tool: PLAN, id: 't', title: 'Task', stages: [{ name: 'One', steps: [{ title: 'A' }, { title: 'B' }] }] } as never)
const spawn = ($: Engine, description: string, prompt = 'Do the thing.') =>
  $.agent.spawn({
    tool_use_id: `spawn-${description}`,
    prompt,
    description,
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  } as never)
// what the desktop says of one agent's strip
let mounts = 0
const stripAlt = async ($: Engine, title: string) => {
  const ui = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: band, requestId: `desk-${++mounts}` } as never)
  const svgs = (await ui.findAll({ type: 'Svg' } as never)) as unknown as { props: { alt?: string } }[]
  return svgs.map(n => n.props.alt ?? '').find(alt => alt.startsWith(`agent ${title}:`)) ?? ''
}
const todos = (states: string[]) => states.map((status, i) => ({ content: `Item ${i}`, status, activeForm: `Doing ${i}` }))
// the characters of a Raster's cells (three 32-bit words per cell, the first the character)
const glyphs = (cells: string) => {
  const bytes = Uint8Array.from(atob(cells), c => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  let out = ''
  for (let i = 0; i < words.length; i += 3) out += String.fromCodePoint(words[i] ?? 32)
  return out.replace(/[⠀-⣿│]/g, ' ')
}
const band = { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 140, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const raster = async ($: Engine, key: string) => {
  const ui = await $.ui.mount({ plugin: 'plan-progress', surface: 'terminal', component: 'AbovePrompt', props: band, requestId: `band-${++mounts}` } as never)
  const el = await ui.find({ type: 'Raster', key } as never)
  return glyphs(String((el as { props: { cells: string } } | undefined)?.props.cells ?? ''))
}

describe('agent steps', () => {
  test('progress_step is registered; the spawn line is added while on and not while off', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.tools).toContain('progress_step')
    await plan($)
    await spawn($, 'Scan tests', 'Look at the tests.')
    expect(w.prompts[0]).toContain('Look at the tests.\n\nProgress: after planning, call mcp__plan-progress__progress_step')
    await $.command.run({ command: 'progress-agent-steps', args: 'off', origin: { kind: 'composer' } } as never)
    expect(w.stored.agentSteps).toBe(false)
    await spawn($, 'Read docs', 'Read the docs.')
    expect(w.prompts[1]).toBe('Read the docs.')
  })

  test('a subagent TodoWrite sets its counts and its strip reads 2/5 · 40%', async ($, on) => {
    world(on)
    await start($)
    await plan($)
    await spawn($, 'Scan tests')
    await $.tool.call({ tool: 'TodoWrite', agentId: 'ag1', todos: todos(['completed', 'completed', 'in_progress', 'pending', 'pending']) } as never)
    expect(await stripAlt($, 'Scan tests')).toContain('2/5 · 40% (Doing 2)')
    expect(await raster($, 'strips-t')).toContain('2/5 · 40%')
  })

  test('progress_step from a subagent updates its strip; from the main loop it is ignored', async ($, on) => {
    world(on)
    await start($)
    await plan($)
    await spawn($, 'Scan tests')
    expect(JSON.stringify(await $.tool.call({ tool: STEP, agentId: 'ag1', done: 3, total: 8 } as never))).toContain('ok')
    expect(JSON.stringify(await $.tool.call({ tool: STEP, done: 1, total: 2 } as never))).toContain('ignored: for subagents')
    expect(await stripAlt($, 'Scan tests')).toContain('3/8 · 38%')
    expect(await raster($, 'strips-t')).toContain('3/8 · 38%')
  })

  test('the pill shows the share of reported steps only once an agent reported', async ($, on) => {
    world(on)
    await start($)
    await plan($)
    await spawn($, 'Scan tests')
    await spawn($, 'Read docs')
    expect(await raster($, 'track-t')).not.toContain('%')
    await $.tool.call({ tool: 'TodoWrite', agentId: 'ag1', todos: todos(['completed', 'completed', 'pending', 'pending', 'pending']) } as never)
    await $.tool.call({ tool: STEP, agentId: 'ag2', done: 1, total: 5 } as never)
    expect(await raster($, 'track-t')).toContain('· 0/2 · 30%')
  })
})
