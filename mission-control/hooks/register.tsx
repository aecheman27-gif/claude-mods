import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, Register, RenderInput, SessionMessage } from 'claude-code'

import type { Call, Category, Fill, GitInfo, Output } from '../types'
import { C, look, shortModel } from './look'
import { bar, estimate, fmt, labelOf, oneLine, tone, toolName, totals } from './meter'

// A skin: restyles the spinner and tool rows, and draws one status block in
// the band above the prompt (stacked over other mods' rows, never replacing
// them), or under flightdeck's session log while that pane is open:
//   [SYS] repo, branch, model and whether hw-write-guard is loaded
//   [CTL] model and effort buttons; a press runs /model or /effort as if typed
//         (where this build has no /effort, the pick is applied to each
//         main-loop request instead)
//   [CTX] how full the context window is and which tool outputs filled it,
//         with a /ctx pane by tool (sizes estimated locally, ~4 chars a token)
// /clean collapses tool rows into a checklist. Reads with $.fs and $.session:
// no network, no processes, no model calls.

const clean = atom({ plugin: 'mission-control', key: 'clean' } as const, false)
const git = atom({ plugin: 'mission-control', key: 'git' } as const, null)
const model = atom({ plugin: 'mission-control', key: 'model' } as const, '')
const guard = atom({ plugin: 'mission-control', key: 'guard' } as const, false)
const effort = atom({ plugin: 'mission-control', key: 'effort' } as const, '')
const hasEffortCommand = atom({ plugin: 'mission-control', key: 'hasEffortCommand' } as const, true)
const override = atom({ plugin: 'mission-control', key: 'override' } as const, '')
const outputs = atom({ plugin: 'mission-control', key: 'outputs' } as const, [])
const pending = atom({ plugin: 'mission-control', key: 'pending' } as const, {})
const fill = atom({ plugin: 'mission-control', key: 'fill' } as const, null)
const categories = atom({ plugin: 'mission-control', key: 'categories' } as const, [])
const ctxBand = atom({ plugin: 'mission-control', key: 'ctxBand' } as const, true)

const STORE_CLEAN = 'clean'
const STORE_CTX_BAND = 'ctx-band'
const CTX_PANE = 'ctx'
const KEEP_OUTPUTS = 1000

export const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const EFFORT_LABEL: Record<string, string> = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhigh', max: 'max' }

/** `claude-sonnet-5-5` → `sonnet`, matched against the buttons. */
export const family = (id: string) => MODELS.find(f => id.toLowerCase().includes(f)) ?? ''

async function findGit($: EngineInterface): Promise<GitInfo | null> {
  let dir = (await $.session.cwd()).replace(/\\/g, '/').replace(/\/+$/, '')
  for (let depth = 0; depth < 40 && dir; depth++) {
    const dotGit = `${dir}/.git`
    if (await $.fs.exists(dotGit)) {
      let gitDir = dotGit
      const stat = await $.fs.stat(dotGit)
      if (stat.kind === 'file') {
        // a worktree or submodule: ".git" names the real git dir
        const m = /^gitdir:\s*(.+)$/m.exec(String(await $.fs.read(dotGit)))
        if (!m) return null
        const target = m[1].trim()
        gitDir = /^([A-Za-z]:|\/)/.test(target) ? target : `${dir}/${target}`
      }
      const head = String(await $.fs.read(`${gitDir}/HEAD`)).trim()
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
      return { repo: dir.split('/').pop() || dir, branch: ref ? ref[1] : `detached ${head.slice(0, 7)}` }
    }
    const up = dir.replace(/\/[^/]*$/, '')
    if (up === dir || up === '' || /^[A-Za-z]:$/.test(dir)) break
    dir = up
  }
  return null
}

async function refresh($: EngineInterface) {
  const [g, m, commands] = await Promise.all([
    findGit($).catch(() => null),
    $.session.model().catch(() => ''),
    $.command.list().catch(() => undefined),
  ])
  await update($, git, () => g)
  await update($, model, () => m)
  if (commands) {
    await update($, guard, () => commands.some(c => c.name === 'hw-guard'))
    await update($, hasEffortCommand, () => commands.some(c => c.name === 'effort'))
  }
}

const isCtxPaneOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === CTX_PANE)

async function refreshContext($: EngineInterface) {
  const withBreakdown = await isCtxPaneOpen($).catch(() => false)
  const usage = await $.session.usage(withBreakdown ? { breakdown: 'summary' } : undefined)
  const c = usage.context
  const now: Fill = { window: c.window }
  if (c.tokens !== undefined) now.tokens = c.tokens
  if (c.percent !== undefined) now.percent = c.percent
  await update($, fill, () => now)

  if (c.breakdown) {
    const used: Category[] = c.breakdown.categories.filter(k => k.kind === 'used' && k.tokens > 0).map(k => ({ name: k.name, tokens: k.tokens }))
    await update($, categories, () => used)
  }
}

// The whole-transcript walk: only at session start, after a compaction and on
// the pane's Refresh. Between those, `outputs` follows the rows as they are
// stored (noteCalls, noteResults).
async function rebuildOutputs($: EngineInterface, messages?: readonly SessionMessage[]) {
  const list: Output[] = []
  const waiting: Record<string, Call> = {}
  for (const m of messages ?? (await $.session.messages())) {
    for (const use of m.toolUses ?? []) {
      const label = labelOf(use.tool, use.input ?? {})
      if (use.text) list.push({ id: use.tool_use_id, tool: use.tool, label, tokens: estimate(use.text) })
      else if (use.text === undefined) waiting[use.tool_use_id] = { tool: use.tool, label }
    }
  }
  await update($, outputs, () => list.slice(-KEEP_OUTPUTS))
  await update($, pending, () => waiting)
}

type Block = Args<'session.append'>['message']['content'][number]

/** A response row's tool_use blocks: remember each call until its result is stored. */
async function noteCalls($: EngineInterface, blocks: readonly Block[]) {
  const uses = blocks.filter(b => b.type === 'tool_use' && typeof b.id === 'string')
  if (uses.length === 0) return
  await update($, pending, p => {
    const next = { ...p }
    for (const b of uses) {
      const tool = String(b.name ?? 'unknown')
      next[b.id as string] = { tool, label: labelOf(tool, (b.input ?? {}) as Record<string, unknown>) }
    }
    return next
  })
}

/** Text blocks of a tool_result's content joined, as the model read them. */
const resultText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(b => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('')
      : ''

/** A tool-result row: each tool_result answering a remembered call becomes one output. */
async function noteResults($: EngineInterface, blocks: readonly Block[], fallbackTool: string) {
  const results = blocks.filter(b => b.type === 'tool_result' && typeof b.tool_use_id === 'string')
  if (results.length === 0) return
  const calls = await read($, pending)
  const fresh: Output[] = []
  for (const r of results) {
    const id = r.tool_use_id as string
    const text = resultText(r.content)
    const call = calls[id] ?? { tool: fallbackTool, label: '' }
    if (text) fresh.push({ id, tool: call.tool, label: call.label, tokens: estimate(text) })
  }
  await update($, pending, p => {
    const next = { ...p }
    for (const r of results) delete next[r.tool_use_id as string]
    return next
  })
  if (fresh.length) await update($, outputs, list => [...list, ...fresh].slice(-KEEP_OUTPUTS))
}

// flightdeck's `dock`: true while its pane is open and drawn. A mod not
// installed reads as never written, so the block stays in the band.
const FLIGHTDECK = 'flightdeck'
const FLIGHTDECK_DOCK = { plugin: 'flightdeck', key: 'dock' } as const
async function isDocked($: EngineInterface) {
  const held = await $.state.get(FLIGHTDECK_DOCK as never).catch(() => undefined)
  return (held as { value?: unknown } | undefined)?.value === true
}

/**
 * [SYS], [CTL] and [CTX], `width` cells across: the band's, or flightdeck's
 * pane's. `hasCtx` false leaves [CTX] out (flightdeck's card shows ctx).
 */
async function statusBlock($: EngineInterface, e: RenderInput<'AbovePrompt' | 'Pane'>, width: number, hasCtx = true) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const [g, m, armed, isClean, level, viaCommand, forced, f, isCtx, outs] = await Promise.all([
    read($, git),
    read($, model),
    read($, guard),
    read($, clean),
    read($, effort),
    read($, hasEffortCommand),
    read($, override),
    read($, fill),
    read($, ctxBand),
    read($, outputs),
  ])

  const sys = (
    <Box backgroundColor={C.bg} width={width}>
      <Text color={C.primary} bold>
        [SYS]{' '}
      </Text>
      <Text wrap="truncate-end">
        <Text color={C.primary}>repo:</Text>
        <Text color="white">{g ? g.repo : '—'} </Text>
        <Text color={C.primary}>⎇ </Text>
        <Text color="white">{g ? g.branch : 'no git'} </Text>
        <Text color={C.primary}>◆ </Text>
        <Text color="white">{m ? shortModel(m) : '…'} </Text>
        <Text color={armed ? C.ok : C.warn} bold>
          [HW-GUARD {armed ? 'ON' : 'OFF'}]
        </Text>
        {isClean ? <Text color={C.dim}> [CLEAN]</Text> : ''}
      </Text>
    </Box>
  )

  const fam = family(m)
  const shown = !viaCommand && forced ? forced : level
  const pickModel = (name: string) => () => {
    void $.command
      .run({ command: 'model', args: name })
      .then(() => refresh($))
      .catch(err => $.ui.toast(`mission-control: /model ${name} failed: ${err instanceof Error ? err.message : String(err)}`))
  }
  const pickEffort = (lvl: string) => async () => {
    await update($, effort, () => lvl)
    if (!viaCommand) {
      await update($, override, () => lvl)
      $.ui.toast(`effort ${lvl}: applied to each request by mission-control (this build has no /effort)`)
      return
    }
    void $.command.run({ command: 'effort', args: lvl }).catch(err => $.ui.toast(`mission-control: /effort ${lvl} failed: ${err instanceof Error ? err.message : String(err)}`))
  }
  // The model and effort halves wrap as wholes, so a narrow pane puts effort on a row of its own.
  const ctl = (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={width}>
      <Box flexDirection="row" columnGap={1}>
        <Text color={C.primary} bold>
          [CTL]
        </Text>
        <Text color={C.dim}>model:</Text>
        <Text color="white" bold>
          {fam || m || '…'}
        </Text>
        {MODELS.map(name => (
          <Button key={`model-${name}`} label={name} variant={name === fam ? 'primary' : 'secondary'} onPress={pickModel(name)} />
        ))}
      </Box>
      <Box flexDirection="row" columnGap={1}>
        <Text color={C.dim}>│ effort:</Text>
        <Text color={shown && shown !== 'n/a' ? 'white' : C.dim} bold>
          {shown || '?'}
          {!viaCommand && forced ? '*' : ''}
        </Text>
        {EFFORTS.map(l => (
          <Button key={`effort-${l}`} label={EFFORT_LABEL[l]} variant={l === shown ? 'primary' : 'secondary'} onPress={pickEffort(l)} />
        ))}
      </Box>
    </Box>
  )

  const top = totals(outs)
    .slice(0, 3)
    .map(t => `${toolName(t.tool)} ${fmt(t.tokens)}`)
    .join(' · ')
  const ctx =
    hasCtx && isCtx && f && f.percent !== undefined && f.tokens !== undefined ? (
      <Box flexDirection="row" width={width}>
        <Text color={C.primary} bold>
          [CTX]{' '}
        </Text>
        <Text color={tone(f.percent)}>{bar(f.percent / 100, 10)}</Text>
        <Text wrap="truncate-end">
          {' '}
          {f.percent}% {fmt(f.tokens)}/{fmt(f.window)}
          {top ? <Text color={C.dim}> · tool output: {top}</Text> : ''}
        </Text>
      </Box>
    ) : null

  return (
    <Box flexDirection="column">
      {sys}
      {ctl}
      {ctx}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'clean', description: 'Toggle mission-control clean view (tool rows as a checklist)' })
    await $.command.register({ name: 'ctx', description: 'Context pane: what fills the window, by tool; "/ctx band" hides or shows the [CTX] row' })
    const saved = await $.store.get(STORE_CLEAN).catch(() => undefined)
    if (typeof saved === 'boolean') await update($, clean, () => saved)
    const savedBand = await $.store.get(STORE_CTX_BAND).catch(() => undefined)
    if (typeof savedBand === 'boolean') await update($, ctxBand, () => savedBand)
    const ran = await next(e)
    await refresh($)
    // awaited: the session's first rows must not land before the rebuild that would overwrite them
    await rebuildOutputs($).catch(() => undefined)
    void refreshContext($).catch(() => undefined)
    // other mods register their commands at session.start too: look again once they have
    $.clock.after(1500, () => void refresh($).catch(() => undefined))
    return ran
  })

  on('command.run', { command: 'clean' }, async $ => {
    let now = false
    await update($, clean, v => (now = !v))
    await $.store.set(STORE_CLEAN, now)
    return { text: now ? 'Clean view on: tool rows show as a checklist.' : 'Clean view off: full tool rows.' }
  })

  on('command.run', { command: 'ctx' }, async ($, e) => {
    if (e.args.trim() === 'band') {
      let now = false
      await update($, ctxBand, v => (now = !v))
      await $.store.set(STORE_CTX_BAND, now)
      return { text: now ? 'Context row on.' : 'Context row off (the /ctx pane still works).' }
    }
    if (await isCtxPaneOpen($)) {
      await $.ui.close({ id: CTX_PANE })
      return { text: 'Context pane closed.' }
    }
    await $.ui.open({ id: CTX_PANE, title: 'Context' })
    await refreshContext($)
    return { text: 'Context pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    void refresh($).catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void refresh($).catch(() => undefined)
    return done
  })

  // Read the effort each main-loop request goes out with; apply the override only without /effort.
  on('turn.step', async function* ($, e, next) {
    let step = e
    if (e.agentId === undefined) {
      const forced = (await read($, hasEffortCommand)) ? '' : await read($, override)
      if (forced && e.effort !== undefined) step = { ...e, effort: forced as (typeof EFFORTS)[number] }
      const sent = step.effort === undefined ? 'n/a' : String(step.effort)
      void update($, effort, () => sent).catch(() => undefined)
    }
    return yield* next(step)
  })

  // Tool outputs follow the main conversation's rows as they are stored: a
  // response's tool_use blocks name the calls, a tool-result row answers them.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined && stored.message) await noteCalls($, stored.message.content).catch(() => undefined)
    return stored
  }).catch(($, e, next) => next(e))

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined && stored.message) {
      const tool = e.origin.kind === 'tool' ? e.origin.tool : 'unknown'
      await noteResults($, stored.message.content, tool).catch(() => undefined)
    }
    return stored
  }).catch(($, e, next) => next(e))

  // A compaction replaces the transcript: rebuild from what it reads as afterwards.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && done.messages) await rebuildOutputs($, done.messages).catch(() => undefined)
    return done
  }).catch(($, e, next) => next(e))

  // The engine measures after each response: the moment the context fill moves.
  // Cheap: the usage reading (and the breakdown while the /ctx pane is open).
  on('session.measure', async ($, e, next) => {
    const ran = await next(e)
    if (e.changed.includes('context')) await refreshContext($).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

  // [SYS] goes into the spinner's own text, so it shares the line with the
  // animated word; a row wrapped around the engine's tree put it on a line of
  // its own above the spinner.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const p = e.props
    return next({ ...e, props: { ...p, word: `[SYS] ${p.word}`, message: p.message === null ? null : `[SYS] ${p.message}` } })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const p = e.props
    const l = look(p.tool, p.input)
    const width = Math.max(20, (e.viewport?.columns ?? 100) - 4)
    const state = p.isInterrupted
      ? { mark: '⏸', color: C.warn, word: 'interrupted' }
      : p.isErrored
        ? { mark: '✖', color: C.warn, word: 'error' }
        : p.isRunning
          ? { mark: '◌', color: C.primary, word: 'running' }
          : { mark: '✔', color: C.ok, word: '' }

    if (await read($, clean)) {
      const box = p.isInterrupted || p.isErrored ? '☒' : p.isRunning ? '☐' : '☑'
      return (
        <Box width={width}>
          <Text color={state.color}>{box} </Text>
          <Text wrap="truncate-end" dimColor={!p.isRunning}>
            {l.verb} {l.target}
          </Text>
        </Box>
      )
    }

    const header = (
      <Box width={width} backgroundColor={C.bg}>
        <Text color={l.color} bold>
          [{l.label}]
        </Text>
        <Text color={l.color}> {l.icon} </Text>
        <Text color={l.color === C.edit ? C.edit : 'white'} bold>
          {p.tool.startsWith('mcp__') ? l.verb : p.tool}{' '}
        </Text>
        <Text wrap="truncate-end" color={C.dim}>
          {l.target}
        </Text>
        <Text color={state.color}>
          {' '}
          {state.mark}
          {state.word ? ` ${state.word}` : ''}
        </Text>
      </Box>
    )
    // While the call runs the engine's row is more than its header line (the
    // live progress beneath it: a command's output, an agent's steps, the
    // background hint), so its drawing stays below ours. A finished row is ours
    // alone: its props can't tell a standalone row (whose result draws as its
    // own ToolResult row) from an expanded group's, and wrapping every finished
    // row would print two headers. The cost: an expanded group's inline results.
    if (!p.isRunning) return header
    return (
      <Box flexDirection="column">
        {header}
        {await next(e)}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, clean))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return e.props.isErrored ? (
      <Box>
        <Text color={C.warn}> ⎿ failed</Text>
      </Box>
    ) : (
      <Box />
    )
  })

  // While flightdeck's pane is open and drawn the block sits under its session
  // log; otherwise it stays in the band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || (await isDocked($))) return below
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await statusBlock($, e, e.props.bodyColumns)}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: FLIGHTDECK }, async ($, e, next) => {
    const above = await next(e)
    if (!(await isDocked($))) return above
    const { Box } = $.ui.resolve(e)
    const width = Math.max(40, e.props.bodyColumns)
    return (
      <Box flexDirection="column" width={width}>
        {/* beneath flightdeck's hook, `above` is the engine's own empty drawing: leave it out */}
        {(above as { type?: string }).type === 'engine' ? null : above}
        <Box flexDirection="column" borderStyle="round" borderColor={C.dim} paddingX={1} width={width}>
          {await statusBlock($, e, width - 4, false)}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: CTX_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [f, list, cats, isBand] = await Promise.all([read($, fill), read($, outputs), read($, categories), read($, ctxBand)])
    const width = e.props.bodyColumns
    const barWidth = Math.max(6, Math.min(24, width - 36))
    const byTool = totals(list).slice(0, 12)
    const nameWidth = Math.min(20, Math.max(4, ...byTool.map(t => toolName(t.tool).length), ...cats.map(c => c.name.length)))
    const most = Math.max(1, byTool[0]?.tokens ?? 1)
    const allTokens = list.reduce((n, o) => n + o.tokens, 0)
    const biggest = [...list].sort((a, b) => b.tokens - a.tokens).slice(0, 10)
    const window = f?.window ?? 1

    return (
      <Box flexDirection="column" width={width}>
        {f && f.percent !== undefined && f.tokens !== undefined ? (
          <Text>
            <Text bold>Context </Text>
            <Text color={tone(f.percent)}>{bar(f.percent / 100, barWidth)}</Text> {f.percent}% · {fmt(f.tokens)} of {fmt(f.window)}
          </Text>
        ) : (
          <Text dimColor>No reading yet: it shows after Claude's next reply.</Text>
        )}
        <Text> </Text>
        <Text bold>
          Tool output in context <Text dimColor>({list.length} calls, ~{fmt(allTokens)} tokens, estimated)</Text>
        </Text>
        {byTool.length === 0 && <Text dimColor>  None yet.</Text>}
        {byTool.map(t => (
          <Text wrap="truncate-end">
            {'  '}
            {toolName(t.tool).padEnd(nameWidth)} <Text color={C.primary}>{bar(t.tokens / most, barWidth)}</Text> {fmt(t.tokens).padStart(5)}
            <Text dimColor>
              {' '}
              {t.calls} call{t.calls === 1 ? '' : 's'}
            </Text>
          </Text>
        ))}
        {biggest.length > 0 && <Text> </Text>}
        {biggest.length > 0 && <Text bold>Biggest outputs</Text>}
        {biggest.map(o => (
          <Text wrap="truncate-end">
            {'  '}
            {fmt(o.tokens).padStart(5)} <Text color={C.primary}>{oneLine(toolName(o.tool), 18)}</Text> <Text dimColor>{oneLine(o.label, Math.max(10, width - 30))}</Text>
          </Text>
        ))}
        {cats.length > 0 && <Text> </Text>}
        {cats.length > 0 && (
          <Text bold>
            Whole window by category <Text dimColor>(estimated)</Text>
          </Text>
        )}
        {cats.map(c => (
          <Text wrap="truncate-end">
            {'  '}
            {oneLine(c.name, nameWidth).padEnd(nameWidth)} <Text color="#a78bfa">{bar(c.tokens / window, barWidth)}</Text> {fmt(c.tokens).padStart(5)}
          </Text>
        ))}
        <Text> </Text>
        <Box flexDirection="row" columnGap={1}>
          <Button key="refresh" label="Refresh" onPress={() => void Promise.all([refreshContext($), rebuildOutputs($)]).catch(() => undefined)} />
          <Button
            key="band"
            label={isBand ? 'Hide band row' : 'Show band row'}
            onPress={() =>
              void update($, ctxBand, v => !v)
                .then(v => $.store.set(STORE_CTX_BAND, v))
                .catch(() => undefined)
            }
          />
        </Box>
      </Box>
    )
  })
}
