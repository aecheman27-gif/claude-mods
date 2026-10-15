import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { shortModel } from './look'
import { bar, fmt, labelOf, totals } from './meter'
import { family } from './register'

type Opts = { commands?: string[]; files?: Record<string, string>; dirs?: string[]; model?: string; isPaneOpen?: boolean; hasReading?: boolean; messages?: unknown[]; compacted?: unknown[] }

const TRANSCRIPT = [
  { role: 'user', text: 'run the tests', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [
      { tool_use_id: 'a', tool: 'Bash', input: { command: 'npm test --verbose' }, text: 'x'.repeat(40_000) },
      { tool_use_id: 'b', tool: 'Read', input: { file_path: 'C:\\work\\src\\big.ts' }, text: 'y'.repeat(8000) },
      { tool_use_id: 'c', tool: 'Bash', input: { command: 'git status' }, text: 'z'.repeat(400) },
      { tool_use_id: 'd', tool: 'Grep', input: { pattern: 'TODO' } }, // still running: no text
    ],
  },
]
// what the transcript reads as after a compaction
const COMPACTED = [
  { role: 'user', text: 'summary of the conversation so far', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'e', tool: 'Read', input: { file_path: 'x/after.ts' }, text: 'q'.repeat(4000) }] },
]

function world(on: On, opts: Opts = {}) {
  mock.clock(on, { now: 0 })
  const w = {
    ran: [] as string[],
    steps: [] as { effort?: unknown; agentId?: string }[],
    toasts: [] as string[],
    stored: {} as Record<string, unknown>,
    opened: [] as string[],
    messageReads: 0,
    messages: opts.messages ?? TRANSCRIPT,
    model: opts.model ?? 'claude-opus-5-5',
  }
  const files: Record<string, string> = opts.files ?? { 'C:/work/app/.git/HEAD': 'ref: refs/heads/feature/x\n' }
  const dirs = new Set(opts.dirs ?? ['C:/work/app/.git'])
  const norm = (p: string) => p.replace(/\\/g, '/')
  on('session.start', async () => ({ cwd: 'C:/work/app' }) as never)
  on('session.cwd', async () => ({ value: 'C:/work/app/src' }) as never)
  on('session.model', async () => ({ value: w.model }) as never)
  on('command.register', async ($, e) => ({ value: { command: e.name } }) as never)
  on('command.list', async () => ({ value: (opts.commands ?? ['hw-guard', 'model', 'effort']).map(name => ({ name, description: '', source: 'plugin' })) }) as never)
  on('command.run', async ($, e) => {
    w.ran.push(`/${e.command} ${e.args}`)
    if (e.command === 'model') w.model = `claude-${e.args}-5-5`
    return { text: 'ok' } as never
  })
  on('fs.exists', async ($, e) => ({ value: dirs.has(norm(e.path)) || norm(e.path) in files }) as never)
  on('fs.stat', async ($, e) => ({ value: { kind: dirs.has(norm(e.path)) ? 'dir' : 'file', size: 1, mtimeMs: 0, isLink: false } }) as never)
  on('fs.read', async ($, e) => {
    const t = files[norm(e.path)]
    if (t === undefined) throw new Error('ENOENT')
    return { value: t } as never
  })
  on('store.get', async ($, e) => ({ value: w.stored[e.key] }) as never)
  on('store.set', async ($, e) => {
    w.stored[e.key] = e.value
    return { value: undefined } as never
  })
  on('ui.toast', async ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined } as never
  })
  on('turn.complete', async () => ({ text: '' }) as never)
  on('turn.step', async function* ($, e) {
    w.steps.push({ effort: e.effort, agentId: e.agentId })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  on('session.measure', async ($, e) => ({ changed: e.changed }) as never)
  on('session.usage', async ($, e) => {
    const reading = opts.hasReading === false ? {} : { tokens: 124_000, percent: 62 }
    const context: Record<string, unknown> = { window: 200_000, ...reading }
    if (e.breakdown) {
      context.breakdown = {
        categories: [
          { name: 'System prompt', tokens: 9000, kind: 'used' },
          { name: 'Messages', tokens: 100_000, kind: 'used' },
          { name: 'Free space', tokens: 76_000, kind: 'free' },
        ],
      }
    }
    return { value: { startedAt: 0, context, rateLimits: [] } } as never
  })
  on('session.messages', async () => {
    w.messageReads++
    return { value: w.messages } as never
  })
  on('session.compact', async () => ({ messages: opts.compacted ?? [] }) as never)
  on('ui.panes', async () => ({ value: opts.isPaneOpen ? [{ id: 'ctx', title: 'Context', isPlaced: true }] : [] }) as never)
  on('ui.open', async ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  // what the mods beneath draw (another band row, the engine's own rows)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: [`ENGINE-${e.component}`] }))
  return w
}

const start = ($: Engine) => $.session.start({ source: 'startup', cwd: 'C:/work/app', surface: 'terminal', isInteractive: true } as never)
const measure = ($: Engine) => $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] } as never)
const band: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} } as never
const pane: RenderPropsOf['Pane'] = { title: 'Context', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never
const row = (tool: string, input: unknown, extra: Partial<RenderPropsOf['ToolUse']> = {}): RenderPropsOf['ToolUse'] =>
  ({ tool_use_id: 't1', tool, input, isRunning: false, isErrored: false, isInterrupted: false, ...extra }) as never
async function step($: Engine, effort: string | undefined, agentId?: string) {
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', effort, messageCount: 2, agentId } as never)
  for await (const _ of s) {
    // drain
  }
  await s.result
}
// rows as the engine stores them: a response's tool_use block, then the tool's result
const respond = ($: Engine, id: string, tool: string, input: unknown, agentId?: string) =>
  $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] },
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid: `resp-${id}`,
    agentId,
  } as never)
const answer = ($: Engine, id: string, tool: string, content: unknown, agentId?: string) =>
  $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
    door: 'tool-result',
    origin: { kind: 'tool', tool },
    uuid: `res-${id}`,
    agentId,
  } as never)
const mountBand = ($: Engine, props = band, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'mission-control', surface, component: 'AbovePrompt', props })
const textOf = async (ui: { findAll: (q: object) => Promise<{ text: string }[]> }) => (await ui.findAll({}))[0]?.text ?? ''

describe('band', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: [SYS], [CTL] and [CTX] in order, stacked above the other mods' rows`, async ($, on) => {
      world(on)
      await start($)
      await measure($)
      const text = await textOf(await mountBand($, band, surface))
      const at = ['[SYS]', '[CTL]', '[CTX]', 'ENGINE-AbovePrompt'].map(s => text.indexOf(s))
      expect(at.every(i => i >= 0)).toBe(true)
      expect([...at].sort((a, b) => a - b)).toEqual(at)
    })
  }

  test('yields to a survey', async ($, on) => {
    world(on)
    await start($)
    await measure($)
    const text = await textOf(await mountBand($, { ...band, hasSurvey: true }))
    expect(text).not.toContain('[SYS]')
    expect(text).not.toContain('[CTL]')
    expect(text).not.toContain('[CTX]')
  })
})

// Stands in for flightdeck: its pane is open and drawn from the session's start
// (`dock`), /undock closes it, and its pane draws a log with what lies beneath under it.
const deck = {
  name: 'flightdeck',
  register: ((on: On) => {
    const dock = { plugin: 'flightdeck', key: 'dock' } as const
    on('session.start', async ($, e, next) => {
      await $.command.register({ name: 'undock', description: 'close the pane' })
      await $.state.set(dock as never, true as never)
      return next(e)
    })
    on('command.run', { command: 'undock' }, async $ => {
      await $.state.set(dock as never, false as never)
      return { text: 'closed' }
    })
    on('ui.render', { component: 'Pane', requestId: 'flightdeck' }, async ($, e, next) => {
      const { Box, Text } = $.ui.resolve(e)
      return Box({ flexDirection: 'column', children: [Text({ children: 'session log' }), await next(e)] })
    })
  }) as never,
}
const deckPane = ($: Engine) =>
  $.ui.mount({ plugin: 'mission-control', surface: 'terminal', component: 'Pane', requestId: 'flightdeck', props: { ...pane, title: 'Flightdeck', bodyColumns: 64 } })

describe("flightdeck's pane", () => {
  test('while it is open the block leaves the band and sits under its session log, without [CTX]', { plugins: [deck] }, async ($, on) => {
    world(on)
    await start($)
    await measure($)
    const bandText = await textOf(await mountBand($))
    expect(bandText).not.toContain('[SYS]')
    expect(bandText).toContain('ENGINE-AbovePrompt')
    const text = await textOf(await deckPane($))
    const at = ['session log', '[SYS]', '[CTL]'].map(s => text.indexOf(s))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(text).not.toContain('[CTX]') // flightdeck's card shows ctx
  })

  test('its buttons work there', { plugins: [deck] }, async ($, on) => {
    const w = world(on)
    await start($)
    const ui = await deckPane($)
    await ui.press({ key: 'model-haiku' })
    expect(w.ran).toContain('/model haiku')
    await ui.press({ key: 'effort-low' })
    expect(w.ran).toContain('/effort low')
  })

  test('once it closes the block is back in the band', { plugins: [deck] }, async ($, on) => {
    world(on)
    await start($)
    const ui = await mountBand($)
    expect(await textOf(ui)).not.toContain('[SYS]')
    await measure($)
    await $.command.run({ command: 'undock', args: '' } as never)
    expect(await textOf(ui)).toContain('[SYS]')
    expect(await textOf(ui)).toContain('[CTX]')
  })
})

// Stands in for hw-write-guard: /hw-guard <mode> publishes its mode in $.state.
// (A stand-in's register runs in an environment of its own: no closure over test values.)
const hwGuard = {
  name: 'hw-write-guard',
  register: ((on: On) => {
    on('command.run', { command: 'hw-guard' }, async ($, e) => {
      await $.state.set({ plugin: 'hw-write-guard', key: 'mode' } as never, e.args as never)
      return { text: `mode ${e.args}` }
    })
  }) as never,
}
const guardLabel = async (ui: { find: (q: object) => Promise<{ text: string; props: { color?: unknown } } | undefined> }) => {
  const found = await ui.find({ type: 'Text', text: /^\[HW-GUARD / })
  return found ? `${found.text} ${String(found.props.color)}` : ''
}

describe('[SYS]', () => {
  test('shows repo, branch, model and the guard', async ($, on) => {
    world(on)
    await start($)
    const text = await textOf(await mountBand($))
    expect(text).toContain('repo:app')
    expect(text).toContain('feature/x')
    expect(text).toContain('opus-5.5')
    expect(text).toContain('[HW-GUARD ?]') // /hw-guard is there; no mode published
  })

  test('guard OFF when hw-guard is not registered', async ($, on) => {
    world(on, { commands: ['other'] })
    await start($)
    expect(await guardLabel(await mountBand($))).toBe('[HW-GUARD OFF] #FFB000')
  })

  test("the guard's mode as it publishes it: ASK green, NOTIFY amber, OFF red, redrawn as it changes", { plugins: [hwGuard] }, async ($, on) => {
    world(on)
    await start($)
    const ui = await mountBand($)
    expect(await guardLabel(ui)).toBe('[HW-GUARD ?] gray') // loaded, no mode published yet
    await $.command.run({ command: 'hw-guard', args: 'ask' } as never)
    expect(await guardLabel(ui)).toBe('[HW-GUARD ASK] green')
    await $.command.run({ command: 'hw-guard', args: 'notify' } as never)
    expect(await guardLabel(ui)).toBe('[HW-GUARD NOTIFY] #FFB000')
    await $.command.run({ command: 'hw-guard', args: 'off' } as never)
    expect(await guardLabel(ui)).toBe('[HW-GUARD OFF] #f87171')
  })

  test('a value that is none of its modes reads as none published: [HW-GUARD ?]', { plugins: [hwGuard] }, async ($, on) => {
    world(on)
    await start($)
    await $.command.run({ command: 'hw-guard', args: 'loud' } as never)
    expect(await guardLabel(await mountBand($))).toBe('[HW-GUARD ?] gray')
  })

  test('worktree .git file is followed', async ($, on) => {
    world(on, {
      files: { 'C:/work/app/.git': 'gitdir: C:/work/main/.git/worktrees/app\n', 'C:/work/main/.git/worktrees/app/HEAD': 'ref: refs/heads/wt-branch\n' },
      dirs: [],
    })
    await start($)
    expect(await textOf(await mountBand($))).toContain('wt-branch')
  })
})

describe('[CTL]', () => {
  test('marks the current model', async ($, on) => {
    world(on, { model: 'claude-sonnet-5-5' })
    await start($)
    const ui = await mountBand($)
    expect((await ui.find({ type: 'Button', key: 'model-sonnet' }))?.props.variant).toBe('primary')
    expect((await ui.find({ type: 'Button', key: 'model-opus' }))?.props.variant).toBe('secondary')
  })

  test('pressing a model button runs /model and the band follows', async ($, on) => {
    const w = world(on)
    await start($)
    const ui = await mountBand($)
    await ui.press({ key: 'model-haiku' })
    expect(w.ran).toContain('/model haiku')
    expect((await ui.find({ type: 'Button', key: 'model-haiku' }))?.props.variant).toBe('primary')
    expect(await textOf(ui)).toContain('haiku-5.5')
  })

  test('effort shows what the last main request was sent with', async ($, on) => {
    world(on)
    await start($)
    await step($, 'xhigh')
    await step($, 'low', 'sub-1')
    const ui = await mountBand($)
    expect((await ui.find({ type: 'Button', key: 'effort-xhigh' }))?.props.variant).toBe('primary')
  })

  test('pressing an effort button runs /effort when it exists', async ($, on) => {
    const w = world(on)
    await start($)
    const ui = await mountBand($)
    await ui.press({ key: 'effort-high' })
    expect(w.ran).toContain('/effort high')
    await step($, 'medium')
    expect(w.steps[0].effort).toBe('medium') // not overridden: /effort is the engine's job
  })

  test('without /effort the pick is applied to main-loop requests only', async ($, on) => {
    const w = world(on, { commands: ['hw-guard', 'model'] })
    await start($)
    const ui = await mountBand($)
    await ui.press({ key: 'effort-max' })
    expect(w.ran.some(r => r.startsWith('/effort'))).toBe(false)
    expect(w.toasts[0]).toContain('no /effort')
    await step($, 'medium')
    await step($, 'medium', 'sub-1')
    expect(w.steps.map(s => s.effort)).toEqual(['max', 'medium'])
    expect(await textOf(ui)).toContain('max*')
  })
})

describe('[CTX]', () => {
  test('fill and the tools whose output fills it', async ($, on) => {
    world(on)
    await start($)
    await measure($)
    const text = await textOf(await mountBand($))
    expect(text).toContain('62% 124k/200k')
    expect(text).toContain('Bash 10k · Read 2.0k')
  })

  test('no reading yet: no [CTX] row', async ($, on) => {
    world(on, { hasReading: false })
    await start($)
    await measure($)
    const text = await textOf(await mountBand($))
    expect(text).not.toContain('[CTX]')
    expect(text).toContain('[SYS]')
  })

  test('/ctx band hides the row and remembers it', async ($, on) => {
    const w = world(on)
    await start($)
    await measure($)
    const r = await $.command.run({ command: 'ctx', args: 'band' } as never)
    expect(r.text).toContain('row off')
    expect(w.stored['ctx-band']).toBe(false)
    expect(await textOf(await mountBand($))).not.toContain('[CTX]')
  })

  test('/ctx opens the pane', async ($, on) => {
    const w = world(on)
    await start($)
    await $.command.run({ command: 'ctx', args: '' } as never)
    expect(w.opened).toEqual(['ctx'])
  })

  test('pane: bars per tool, biggest outputs, categories', async ($, on) => {
    const w = world(on, { isPaneOpen: true })
    await start($)
    await measure($)
    const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', component: 'Pane', props: pane, requestId: 'ctx' } as never)
    const text = await textOf(ui)
    expect(text).toContain('62% · 124k of 200k')
    expect(text).toContain('3 calls, ~12k tokens')
    expect(text).toMatch(/Bash\s+█+\s+10k\s+2 calls/)
    expect(text).toContain('npm test --verbose')
    expect(text).toContain('big.ts')
    expect(text).toMatch(/Messages\s+[█░]+\s+100k/)
    expect(text).not.toContain('Free space')
    await ui.press({ key: 'band' })
    expect(w.stored['ctx-band']).toBe(false)
  })

  test('outputs follow the stored rows: a reply measures without reading the transcript', async ($, on) => {
    const w = world(on, { messages: [] })
    await start($)
    expect(w.messageReads).toBe(1) // session start only
    await respond($, 'r1', 'Bash', { command: 'npm run build' })
    await answer($, 'r1', 'Bash', [{ type: 'text', text: 'b'.repeat(20_000) }])
    await measure($)
    expect(await textOf(await mountBand($))).toContain('tool output: Bash 5.0k')
    await respond($, 'r2', 'Read', { file_path: 'C:/work/app/src/main.ts' })
    await answer($, 'r2', 'Read', 'm'.repeat(4000)) // content as a plain string
    await respond($, 's1', 'Bash', { command: 'subagent work' }, 'agent-1')
    await answer($, 's1', 'Bash', 'q'.repeat(80_000), 'agent-1') // a subagent's: not the main window
    await measure($)
    await measure($)
    expect(w.messageReads).toBe(1)
    expect(await textOf(await mountBand($))).toContain('tool output: Bash 5.0k · Read 1.0k')
  })

  test('a compaction rebuilds the outputs from what the transcript reads as afterwards', async ($, on) => {
    world(on, { compacted: COMPACTED })
    await start($)
    await measure($)
    expect(await textOf(await mountBand($))).toContain('tool output: Bash 10k · Read 2.0k')
    await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT } as never)
    const text = await textOf(await mountBand($))
    expect(text).toContain('tool output: Read 1.0k')
    expect(text).not.toContain('Bash 10k')
  })

  // Where an organization manages Claude Code, session.compact passes over installed plugins.
  const fellTo = ($: Engine, tokens: number) => $.session.measure({ context: { window: 200_000, tokens, percent: tokens / 2000 }, rateLimits: [], changed: ['context'] } as never)

  test('where session.compact never reaches it, the fill falling to under half rebuilds the outputs', async ($, on) => {
    const w = world(on)
    await start($)
    await measure($)
    expect(await textOf(await mountBand($))).toContain('tool output: Bash 10k · Read 2.0k')
    w.messages = COMPACTED
    await fellTo($, 100_000) // 124k to 100k: no compaction
    expect(await textOf(await mountBand($))).toContain('Bash 10k')
    await fellTo($, 30_000)
    const text = await textOf(await mountBand($))
    expect(text).toContain('tool output: Read 1.0k')
    expect(text).not.toContain('Bash 10k')
  })

  test('where it does reach it, the drop that follows is not walked again', async ($, on) => {
    const w = world(on, { compacted: COMPACTED })
    await start($)
    await measure($)
    await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT } as never)
    const reads = w.messageReads
    await fellTo($, 30_000)
    expect(w.messageReads).toBe(reads)
    expect(await textOf(await mountBand($))).toContain('tool output: Read 1.0k')
  })

  test('a long command is kept as a capped label', async ($, on) => {
    world(on, { messages: [], isPaneOpen: true })
    await start($)
    const heredoc = `cat <<'EOF' > notes.txt\n${'line of text\n'.repeat(500)}EOF`
    await respond($, 'h1', 'Bash', { command: heredoc })
    await answer($, 'h1', 'Bash', 'done '.repeat(100))
    const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', component: 'Pane', props: { ...pane, bodyColumns: 2000 }, requestId: 'ctx' } as never)
    const text = await textOf(ui)
    expect(text).toContain("cat <<'EOF' > notes.txt line of text")
    expect(text).not.toContain('line of text '.repeat(20))
    expect(labelOf('Bash', { command: heredoc }).length).toBe(160)
  })
})

describe('tool rows', () => {
  test('edit rows are labelled [EDIT] in magenta', async ($, on) => {
    world(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', component: 'ToolUse', props: row('Edit', { file_path: 'C:/work/app/src/main.py' }) })
    const label = await ui.find({ type: 'Text', text: '[EDIT]' })
    expect(label?.props.color).toBe('magenta')
    expect(await textOf(ui)).toContain('src/main.py')
  })

  test('bash rows are [TOOL] and show running state', async ($, on) => {
    world(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', component: 'ToolUse', props: row('Bash', { command: 'pytest -q' }, { isRunning: true }) })
    const text = await textOf(ui)
    expect(text).toContain('[TOOL]')
    expect(text).toContain('pytest -q')
    expect(text).toContain('running')
  })

  test("a running row keeps the engine's drawing beneath the header; a finished one is one line", async ($, on) => {
    world(on)
    await start($)
    const mount = (props: RenderPropsOf['ToolUse']) => $.ui.mount({ plugin: 'mission-control', surface: 'terminal', component: 'ToolUse', props })
    const running = await textOf(await mount(row('Agent', { description: 'explore the repo' }, { tool_use_id: 't2', isRunning: true })))
    expect(running).toContain('[AGENT]')
    expect(running.indexOf('ENGINE-ToolUse')).toBeGreaterThan(running.indexOf('[AGENT]')) // its live progress, below
    const answered = await textOf(await mount(row('Bash', { command: 'ls' }, { tool_use_id: 't3', output: { stdout: 'a\nb', stderr: '' } })))
    expect(answered).toContain('[TOOL]')
    expect(answered).not.toContain('ENGINE-ToolUse') // no second header
    const plain = await textOf(await mount(row('Bash', { command: 'ls' }, { tool_use_id: 't4' })))
    expect(plain).toContain('[TOOL]')
    expect(plain).not.toContain('ENGINE-ToolUse')
    await $.command.run({ command: 'clean' })
    const checked = await textOf(await mount(row('Bash', { command: 'ls' }, { tool_use_id: 't5', output: { stdout: 'a', stderr: '' } })))
    expect(checked).toContain('☑ Run ls')
    expect(checked).not.toContain('ENGINE-ToolUse')
  })

  test('/clean toggles the checklist view and hides results', async ($, on) => {
    world(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', component: 'ToolUse', props: row('Read', { file_path: 'a/b/config.py' }) })
    const result = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: 't1', tool: 'Read', output: {}, isErrored: false } as never })
    expect(await textOf(result)).toContain('ENGINE-ToolResult')
    const on1 = await $.command.run({ command: 'clean' })
    expect(on1.text).toContain('on')
    expect(await textOf(ui)).toContain('☑ Read a/b/config.py')
    expect(await textOf(result)).not.toContain('ENGINE-ToolResult')
    const off = await $.command.run({ command: 'clean' })
    expect(off.text).toContain('off')
    expect(await textOf(ui)).toContain('[READ]')
  })

  test('spinner: [SYS] rides in the engine line itself, message too', async ($, on) => {
    const seen: { word: string; message: string | null }[] = []
    on('ui.render', { component: 'Spinner' }, ($, e) => {
      seen.push({ word: e.props.word, message: e.props.message })
      return $.ui.resolve(e).Text({ children: [`ENGINE ${e.props.message ?? e.props.word}`] })
    })
    world(on)
    await start($)
    const props = { word: 'Razzle-dazzling', message: null, suffix: '…', mode: 'thinking' }
    const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', component: 'Spinner', props: props as never })
    expect(await textOf(ui)).toBe('ENGINE [SYS] Razzle-dazzling')
    const busy = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', component: 'Spinner', requestId: 'agent-2', props: { ...props, message: 'Compacting' } } as never)
    expect(await textOf(busy)).toBe('ENGINE [SYS] Compacting')
    expect(seen.at(-1)).toEqual({ word: '[SYS] Razzle-dazzling', message: '[SYS] Compacting' })
  })
})

test('helpers', async () => {
  expect(shortModel('claude-opus-5-5')).toBe('opus-5.5')
  expect(shortModel('claude-sonnet-5-5[1m]')).toBe('sonnet-5.5 [1m]')
  expect(family('claude-opus-5-5[1m]')).toBe('opus')
  expect(family('claude-fable-5-1')).toBe('fable')
  expect(family('something-else')).toBe('')
  expect(fmt(950)).toBe('950')
  expect(fmt(2000)).toBe('2.0k')
  expect(fmt(124_000)).toBe('124k')
  expect(bar(0.5, 4)).toBe('██░░')
  expect(bar(2, 3)).toBe('███')
  expect(labelOf('Read', { file_path: 'C:\\a\\b\\c.ts' })).toBe('c.ts')
  expect(labelOf('Bash', { command: 'ls' })).toBe('ls')
  expect(labelOf('Bash', { command: 'x'.repeat(5000) })).toBe('x'.repeat(159) + '…')
  expect(labelOf('Read', { file_path: `C:/${'d/'.repeat(200)}deep.ts` })).toBe('deep.ts')
  expect(
    totals([
      { id: '1', tool: 'Read', label: '', tokens: 5 },
      { id: '2', tool: 'Bash', label: '', tokens: 4 },
      { id: '3', tool: 'Bash', label: '', tokens: 4 },
    ]),
  ).toEqual([
    { tool: 'Bash', calls: 2, tokens: 8 },
    { tool: 'Read', calls: 1, tokens: 5 },
  ])
})
