// the rules around a turn against the engine itself: what a plan_progress call may do, when sounds play, who
// clears a waiting bar, what a plan approved in plan mode inherits, when Stop sends a turn back, and the edit nudge
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLAN = 'mcp__plan-progress__plan_progress'

type Bar = { id: string; title: string; state: string; startedAt: number; stages: { steps: { title: string; status: string }[] }[] }

function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = { clock, stored: {} as Record<string, unknown>, procs: [] as string[][], played: 0, writes: [] as string[], ran: [] as string[], planText: '', plans: [] as Bar[] }
  // the bars as last written: the test's $ has no state noun, so its writes are read on their way to the kit
  on('state.set', async ($, e, next) => {
    const r = await next(e)
    if (e.plugin === 'plan-progress' && e.key === 'plans' && !(r as { deny?: unknown }).deny) w.plans = e.value as Bar[]
    return r
  })
  on('session.start', async () => ({ cwd: 'C:/work' }) as never)
  on('session.id', async () => ({ value: 'session-1' }) as never)
  on('tool.register', async () => ({ value: undefined }) as never)
  on('command.register', async ($, e) => ({ value: { command: e.name } }) as never)
  on('config.list', async () => ({ value: [] }) as never)
  on('store.get', async ($, e) => ({ value: w.stored[e.key] }) as never)
  on('store.set', async ($, e) => {
    w.stored[e.key] = e.value
    return { value: undefined } as never
  })
  on('store.delete', async ($, e) => {
    delete w.stored[e.key]
    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: Object.keys(w.stored) }) as never)
  on('process.run', async ($, e) => {
    w.procs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('audio.play', async () => {
    w.played += 1
    return { value: undefined } as never
  })
  on('fs.write', async ($, e) => {
    w.writes.push(e.path)
    return { value: undefined } as never
  })
  on('prompt.submit', async ($, e) => ({ text: e.text, context: e.context }) as never)
  on('turn.start', async ($, e) => ({ turnId: e.turnId }) as never)
  on('classic.Stop', async () => ({}) as never)
  on('tool.call', { tool: 'ExitPlanMode' }, async () => ({ result: { plan: w.planText } }) as never)
  on('tool.call', async ($, e) => {
    w.ran.push(e.tool)
    return { result: {}, text: 'ok' } as never
  })
  return w
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true } as never)
const plan = ($: Engine, id = 't', title = 'Task') =>
  $.tool.call({ tool: PLAN, id, title, stages: [{ name: 'One', steps: [{ title: 'A' }, { title: 'B' }] }] } as never)
const edit = ($: Engine) => $.tool.call({ tool: 'Edit', file_path: 'C:/work/a.ts', old_string: 'a', new_string: 'b' } as never)
const turn = ($: Engine, turnId: string) => $.turn.start({ text: 'go', turnId } as never)
const stop = ($: Engine, more: Record<string, unknown> = {}) =>
  $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'All set.', background_tasks: [], session_crons: [], ...more } as never) as Promise<{ block?: string }>
const command = ($: Engine, name: string, args: string) => $.command.run({ command: name, args, origin: { kind: 'composer' } } as never)
const bar = (w: ReturnType<typeof world>, id: string) => w.plans.find(p => p.id === id)
const steps = (p: Bar | undefined) => (p?.stages ?? []).flatMap(s => s.steps.map(st => `${st.title}:${st.status}`)).join(' ')
// one main-loop question: the decision sound, through PowerShell on Windows and the engine's player elsewhere
const sounds = async ($: Engine, w: ReturnType<typeof world>) => {
  const before = w.procs.length + w.played
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await w.clock.settle()
  return w.procs.length + w.played - before
}

describe('plan_progress calls', () => {
  test('"reel" is an ordinary bar id: no demo starts and no file is written', async ($, on) => {
    const w = world(on)
    await start($)
    const r = JSON.stringify(await $.tool.call({ tool: PLAN, id: 'reel', note: 'C:/Users/me/evil.txt' } as never))
    expect(r).not.toContain('reel started')
    expect(r).toContain('no bar \\"reel\\" yet')
    await w.clock.advance(15_000)
    expect(w.writes).toEqual([])
  })
})

describe('sounds', () => {
  test('PowerShell runs without -ExecutionPolicy', async ($, on) => {
    const w = world(on)
    await start($)
    expect(await sounds($, w)).toBeGreaterThan(0)
    expect(w.procs.flat()).not.toContain('-ExecutionPolicy')
    expect(w.procs.flat()).not.toContain('Bypass')
  })

  test('the sounds option off plays nothing', { options: { sounds: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    expect(await sounds($, w)).toBe(0)
  })

  test('/progress-sounds off plays nothing and is kept; on plays again', async ($, on) => {
    const w = world(on)
    await start($)
    await command($, 'progress-sounds', 'off')
    expect(w.stored.sounds).toBe(false)
    expect(await sounds($, w)).toBe(0)
    await command($, 'progress-sounds', 'on')
    expect(w.stored.sounds).toBe(true)
    expect(await sounds($, w)).toBeGreaterThan(0)
  })
})

describe('a bar waiting on the person', () => {
  test('clears on the person prompt from any door: composer, Remote Control, a plugin asUser', async ($, on) => {
    const w = world(on)
    await start($)
    await plan($)
    const people = [{ kind: 'composer' }, { kind: 'bridge' }, { kind: 'plugin', name: 'next-steps', asUser: true }]
    for (const origin of people) {
      await $.tool.call({ tool: PLAN, id: 't', state: 'needs_input', note: 'Pick one' } as never)
      await $.prompt.submit({ text: 'yes', origin, wait: false } as never)
      expect(bar(w, 't')?.state).toBe('running')
    }
    // a plugin speaking for itself, or another session, is not the person answering
    for (const origin of [{ kind: 'plugin', name: 'other' }, { kind: 'peer' }]) {
      await $.tool.call({ tool: PLAN, id: 't', state: 'needs_input', note: 'Pick one' } as never)
      await $.prompt.submit({ text: 'fyi', origin, wait: false } as never)
      expect(bar(w, 't')?.state).toBe('needs_input')
    }
  })
})

describe('a plan approved in plan mode', () => {
  test('inherits done steps and its start only from a running bar of the same title', async ($, on) => {
    const w = world(on)
    await start($)
    await $.tool.call({ tool: PLAN, id: 'plan', title: 'Old work', stages: [{ name: 'S', steps: [{ title: 'Setup', status: 'done' }, { title: 'Build' }] }] } as never)
    await w.clock.advance(60_000)
    w.planText = '# New work\n- Setup\n- Build'
    await $.tool.call({ tool: 'ExitPlanMode' } as never)
    let p = bar(w, 'plan')
    expect(p?.title).toBe('New work')
    expect(steps(p)).toBe('Setup:active Build:pending')
    expect(p?.startedAt).toBe(w.clock.now())

    // the same plan revised while it runs keeps what is finished
    await $.tool.call({ tool: PLAN, id: 'plan', next: true } as never)
    const startedAt = p?.startedAt
    await w.clock.advance(60_000)
    w.planText = '# New work\n- Setup\n- Build\n- Ship'
    await $.tool.call({ tool: 'ExitPlanMode' } as never)
    p = bar(w, 'plan')
    expect(steps(p)).toBe('Setup:done Build:active Ship:pending')
    expect(p?.startedAt).toBe(startedAt)

    // a finished bar of that title is history, not a head start
    await $.tool.call({ tool: PLAN, id: 'plan', state: 'done' } as never)
    await $.tool.call({ tool: 'ExitPlanMode' } as never)
    p = bar(w, 'plan')
    expect(steps(p)).toBe('Setup:active Build:pending Ship:pending')
    expect(p?.state).toBe('running')
  })
})

describe('Stop', () => {
  test('sends back a turn that left its own bar open', async ($, on) => {
    world(on)
    await start($)
    await turn($, 't1')
    await plan($)
    await edit($)
    expect((await stop($)).block).toContain('t still open')
  })

  test('lets the turn end while a /loop or wakeup will check back', async ($, on) => {
    world(on)
    await start($)
    await turn($, 't1')
    await plan($)
    await edit($)
    const cron = { id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check the build' }
    expect((await stop($, { session_crons: [cron] })).block).toBeUndefined()
  })

  test('a subagent moving a bar does not make it the turn', async ($, on) => {
    world(on)
    await start($)
    await turn($, 't1')
    await plan($)
    await turn($, 't2')
    await $.tool.call({ tool: PLAN, id: 't', next: true, agentId: 'ag1' } as never)
    expect((await stop($)).block).toBeUndefined()
  })

  test('a bar left from an earlier turn does not hold up a turn that never touched it', async ($, on) => {
    world(on)
    await start($)
    await turn($, 't1')
    await plan($)
    await turn($, 't2')
    await edit($)
    expect((await stop($)).block).toBeUndefined()
  })
})

describe('edits without a bar', () => {
  test('the 4th edit runs and carries a nudge to open a bar; no edit is refused', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, 't1')
    for (let i = 0; i < 3; i++) await edit($)
    const r = JSON.stringify(await edit($))
    expect(r).not.toContain('"deny"')
    expect(w.ran.filter(t => t === 'Edit').length).toBe(4)
    expect(r).toContain(`Create a bar with ${PLAN}`)
    // once a turn
    expect(JSON.stringify(await edit($))).not.toContain('Create a bar')
  })
})
