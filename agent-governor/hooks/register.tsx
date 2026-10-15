import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Gov, Settings } from '../types'
import { bandRow, crossings, empty, finished, parseCommand, reconcile, running, settingsFrom, spawned, statusText, stepped, tokensOf } from './govern'

// Watches the session's subagents: which run, how many at once, and how many
// tokens each and all of them used. A [GOV] row above the prompt while any
// runs, and a toast once each time a limit is crossed. Warn-only by default:
// `/governor caps on` asks before a spawn past the concurrency limit and
// denies the tool calls of an agent past its budget; `/governor route` picks
// a model per agent type when the spawn named none. No network, no
// processes, no model calls.
//
// Running vs finished: an agent is running from its spawn (agent.spawn's
// agentId) and on every model step of its loop (turn.step's agentId); its own
// turn.complete ends it. `$.agent.list()` is the authority behind that: asked
// a few seconds after tool activity while anything runs, its statuses correct
// what the events missed (a killed agent, one spawned before this loaded).

const STORE_SETTINGS = 'settings'
const RECONCILE_MS = 3000
const OVER_BUDGET = 'agent-governor: this agent used its token budget; stop and hand back your findings now.'
const gov = atom({ plugin: 'agent-governor', key: 'gov' } as const, empty())

// Mirrors for the paths that must not read `$` (a .catch handler) or should
// not read it on every call (tool.call). A reload clears them; `ensure` and
// the next change fill them again.
let isLoaded = false
let isCapsOn = false
let isLive = false
let isQueued = false
// Spawns past the check whose agent is not recorded yet (recording waits for
// `next`): spawns made at once each read the state before any records its
// agent, so these count toward the limit too.
let inFlight = 0

// An agent over its budget may still wind down: hand its report back, message,
// stop a task. Denying these loses the report and costs a request per retry.
const WIND_DOWN = new Set(['SubagentHandback', 'SendMessage', 'TaskStop'])

const tooMany = (n: number, max: number) =>
  `agent-governor: ${n} subagents are already running (limit ${max}). Wait for the running agents to finish and hand back their results, then start this one if it is still needed.`

/** The governor's state with the stored settings in it, read from the store once per load. */
async function ensure($: EngineInterface): Promise<Gov> {
  if (!isLoaded) {
    const settings = settingsFrom(await $.store.get(STORE_SETTINGS).catch(() => undefined))
    isLoaded = true
    isCapsOn = settings.caps
    return update($, gov, g => ({ ...g, settings }))
  }
  return read($, gov)
}

/** Applies a change and toasts each limit it crossed. */
async function change($: EngineInterface, fn: (g: Gov, now: number) => Gov): Promise<Gov> {
  const now = await $.clock.now()
  let before: Gov | undefined
  const after = await update($, gov, g => {
    before = g
    return fn(g, now)
  })
  if (before && before !== after) for (const text of crossings(before, after)) $.ui.toast(text)
  isLive = running(after).length > 0
  return after
}

async function setSettings($: EngineInterface, fn: (s: Settings) => Settings): Promise<Gov> {
  await ensure($)
  const g = await update($, gov, g => ({ ...g, settings: fn(g.settings) }))
  isCapsOn = g.settings.caps
  await $.store.set(STORE_SETTINGS, g.settings)
  return g
}

// Ask the engine's list once activity settles; never two asks queued.
function soon($: EngineInterface) {
  if (isQueued) return
  isQueued = true
  $.clock.after(RECONCILE_MS, () => {
    isQueued = false
    void reconcileNow($).catch(() => undefined)
  })
}

async function reconcileNow($: EngineInterface) {
  const fetchedAt = await $.clock.now()
  const list = await $.agent.list()
  await change($, (g, now) => reconcile(g, list, fetchedAt, now))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'governor',
      description: 'Subagent governor: status, limits (max/budget/session), opt-in caps and model routing per agent type',
      argumentHint: 'max N | budget N | session N | caps on|off | route <type>=<model>|off',
    })
    await ensure($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'governor' }, async ($, e) => {
    const cmd = parseCommand(e.args)
    const now = await $.clock.now()
    switch (cmd.kind) {
      case 'status':
        return { text: statusText(await ensure($), now) }
      case 'error':
        return { text: cmd.text }
      case 'set': {
        const g = await setSettings($, s => ({ ...s, [cmd.key]: cmd.value }))
        return { text: `agent-governor: ${cmd.key === 'maxConcurrent' ? `max ${g.settings.maxConcurrent} concurrent` : cmd.key === 'agentBudget' ? `budget ${g.settings.agentBudget} tokens per agent` : `session budget ${g.settings.sessionBudget} tokens`}.` }
      }
      case 'caps':
        await setSettings($, s => ({ ...s, caps: cmd.isOn }))
        return {
          text: cmd.isOn
            ? 'agent-governor: caps ON. Spawns past the concurrency limit ask first; an agent past its token budget has its tool calls denied.'
            : 'agent-governor: caps off. Watching and warning only.',
        }
      case 'routes-off':
        await setSettings($, s => ({ ...s, routes: {} }))
        return { text: 'agent-governor: routing off; agents run on the model their call or definition picks.' }
      case 'route': {
        const g = await setSettings($, s => {
          const routes = { ...s.routes }
          if (cmd.model) routes[cmd.type] = cmd.model
          else delete routes[cmd.type]
          return { ...s, routes }
        })
        const all = Object.entries(g.settings.routes)
        return {
          text: `agent-governor: ${cmd.model ? `${cmd.type} spawns with no model given run on ${cmd.model}` : `no route for ${cmd.type}`}. Routes: ${all.length ? all.map(([t, m]) => `${t}=${m}`).join(', ') : 'none'}.`,
        }
      }
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const g = await ensure($)
    const s = g.settings
    const route = s.routes[e.subagentType]
    const input = route && !e.model && !e.fork && !e.workflow ? { ...e, model: route } : e
    if (s.caps) {
      const n = running(g).length + inFlight
      if (n >= s.maxConcurrent) {
        const answer = await $.ui.ask(`${n} agents already running. Start another?`, { options: ['Start it', 'Deny'], header: 'Governor' }).catch(() => 'Deny')
        if (answer !== 'Start it') return { deny: tooMany(n, s.maxConcurrent) }
      }
    }
    inFlight++
    try {
      const started = await next(input)
      if (started.agentId) {
        const id = started.agentId
        await change($, (g, now) => spawned(g, { id, type: e.subagentType || 'agent', description: e.description }, now)).catch(() => undefined)
      }
      return started
    } finally {
      inFlight--
    }
  }).catch(($, e, next) => (next.called ? next(e) : isCapsOn ? { deny: 'agent-governor: its check failed while caps are on; try the spawn again.' } : next(e)))

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (e.agentId) {
      const id = e.agentId
      const g = await change($, (g, now) => stepped(g, id, tokensOf(r.usage), now)).catch(() => null)
      if (g && !g.agents[id]) soon($) // a loop we never saw spawn: the list may name it
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) {
      const id = e.agentId
      await change($, (g, now) => finished(g, id, now)).catch(() => undefined)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId && (isCapsOn || !isLoaded) && !WIND_DOWN.has(String(e.tool))) {
      const g = await ensure($)
      const a = g.agents[e.agentId]
      if (g.settings.caps && a && a.tokens > g.settings.agentBudget) return { deny: OVER_BUDGET }
    }
    const r = await next(e)
    if (isLive) soon($)
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const row = bandRow(await read($, gov))
    if (!row) return below
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box width={e.props.bodyColumns}>
          <Text wrap="truncate-end">
            <Text bold color={row.warnings.length ? '#f87171' : '#a78bfa'}>
              [GOV]{' '}
            </Text>
            {row.text}
            {row.warnings.length > 0 && <Text color="#f87171"> · ⚠ {row.warnings.join(' · ')}</Text>}
          </Text>
        </Box>
        {below}
      </Box>
    )
  })
}
