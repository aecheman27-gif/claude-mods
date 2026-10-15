import type { AgentInfo, AgentStatus, ModelUsage } from 'claude-code'

import type { Gov, Settings, Tracked } from '../types'

// Pure helpers: every change to the governor's state is a function from the
// old state to the new, so register.tsx can hand them to `update` (which may
// run one twice) and compare before with after to find what crossed a limit.

export const DEFAULTS: Settings = { maxConcurrent: 6, agentBudget: 300_000, sessionBudget: 3_000_000, caps: false, routes: {} }
export const KEEP_FINISHED_MS = 60 * 60 * 1000
const MAX_TRACKED = 200
const LIVE: readonly AgentStatus[] = ['pending', 'running', 'waiting']

export const empty = (settings: Settings = DEFAULTS): Gov => ({ agents: {}, peak: 0, spawned: 0, sessionTokens: 0, perType: {}, settings })

export const running = (g: Gov): Tracked[] => Object.values(g.agents).filter(a => a.isRunning)

/**
 * New tokens a request cost: uncached input, cache writes and output. Cache reads are left out: a
 * long agent loop re-reads its whole transcript every step at a tenth of the price, and counting
 * those would trip any budget on cheap re-reads rather than on work.
 */
export const tokensOf = (u: ModelUsage | null | undefined): number =>
  u ? (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0

export function fmtTok(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** `300000`, `300k`, `3m`, `1.5M`, `3_000_000` -> a positive whole number, or null. */
export function parseCount(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(text.trim().replace(/[_,]/g, ''))
  if (!m) return null
  const n = Math.round(Number(m[1]) * (m[2] ? (m[2].toLowerCase() === 'k' ? 1000 : 1_000_000) : 1))
  return n > 0 && Number.isFinite(n) ? n : null
}

const ALIASES = ['sonnet', 'opus', 'haiku', 'fable']

/**
 * A route's model, lowercased: an alias the Agent tool takes or a full `claude-` id; null for
 * anything else, so a typo (`sonet`) never reaches the store and breaks every spawn of the type.
 */
export function modelOf(text: string): string | null {
  const m = text.trim().toLowerCase()
  return ALIASES.includes(m) || /^claude-[a-z0-9.-]+(\[1m\])?$/.test(m) ? m : null
}

/** Settings as stored, each field checked, the defaults where one is missing or bad. */
export function settingsFrom(stored: unknown): Settings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<Record<keyof Settings, unknown>>
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : d)
  const routes: Record<string, string> = {}
  if (s.routes && typeof s.routes === 'object') {
    for (const [type, model] of Object.entries(s.routes as Record<string, unknown>)) {
      const valid = typeof model === 'string' ? modelOf(model) : null
      if (valid) routes[type] = valid
    }
  }
  return {
    maxConcurrent: num(s.maxConcurrent, DEFAULTS.maxConcurrent),
    agentBudget: num(s.agentBudget, DEFAULTS.agentBudget),
    sessionBudget: num(s.sessionBudget, DEFAULTS.sessionBudget),
    caps: s.caps === true,
    routes,
  }
}

function withPeak(g: Gov): Gov {
  const n = running(g).length
  return n > g.peak ? { ...g, peak: n } : g
}

/** Drops finished agents older than an hour (and the oldest finished past 200 tracked); totals stay. */
export function prune(g: Gov, now: number): Gov {
  const kept = Object.values(g.agents).filter(a => a.isRunning || (a.endedAt ?? now) > now - KEEP_FINISHED_MS)
  const finished = kept.filter(a => !a.isRunning).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
  const drop = new Set(finished.slice(0, Math.max(0, kept.length - MAX_TRACKED)).map(a => a.id))
  const agents = Object.fromEntries(kept.filter(a => !drop.has(a.id)).map(a => [a.id, a]))
  return Object.keys(agents).length === Object.keys(g.agents).length ? g : { ...g, agents }
}

export function spawned(g: Gov, a: { id: string; type: string; description: string }, now: number): Gov {
  if (g.agents[a.id]) return withPeak({ ...g, agents: { ...g.agents, [a.id]: { ...g.agents[a.id], isRunning: true, endedAt: undefined, touchedAt: now } } })
  const n = (g.perType[a.type] ?? 0) + 1
  const t: Tracked = { id: a.id, type: a.type, label: `${a.type}#${n}`, description: a.description, startedAt: now, tokens: 0, isRunning: true, touchedAt: now }
  return withPeak(prune({ ...g, spawned: g.spawned + 1, perType: { ...g.perType, [a.type]: n }, agents: { ...g.agents, [a.id]: t } }, now))
}

/** One model request of an agent's loop answered: its tokens count, and it is running. Unknown ids are left alone. */
export function stepped(g: Gov, id: string, tokens: number, now: number): Gov {
  const a = g.agents[id]
  if (!a) return g
  return withPeak({ ...g, sessionTokens: g.sessionTokens + tokens, agents: { ...g.agents, [id]: { ...a, tokens: a.tokens + tokens, isRunning: true, endedAt: undefined, touchedAt: now } } })
}

/** The agent's run ended (its own turn.complete); a later step marks it running again. */
export function finished(g: Gov, id: string, now: number): Gov {
  const a = g.agents[id]
  if (!a || !a.isRunning) return g
  return prune({ ...g, agents: { ...g.agents, [id]: { ...a, isRunning: false, endedAt: now, touchedAt: now } } }, now)
}

/**
 * The engine's list is the authority on who is alive: a listed agent takes its
 * status from it, unless an event of its own touched it after the list was
 * asked for (that event is newer). A live agent nobody saw spawn is adopted;
 * one missing from the list is left as it was.
 */
export function reconcile(g: Gov, list: readonly Pick<AgentInfo, 'id' | 'type' | 'description' | 'status'>[], fetchedAt: number, now: number): Gov {
  let agents = g.agents
  let perType = g.perType
  let spawnedN = g.spawned
  for (const info of list) {
    const isLive = LIVE.includes(info.status)
    const a = agents[info.id]
    if (a) {
      if (a.touchedAt > fetchedAt || a.isRunning === isLive) continue
      agents = { ...agents, [info.id]: { ...a, isRunning: isLive, endedAt: isLive ? undefined : now } }
    } else if (isLive) {
      const n = (perType[info.type] ?? 0) + 1
      perType = { ...perType, [info.type]: n }
      spawnedN++
      agents = { ...agents, [info.id]: { id: info.id, type: info.type, label: `${info.type}#${n}`, description: info.description, startedAt: now, tokens: 0, isRunning: true, touchedAt: now } }
    }
  }
  return agents === g.agents ? g : withPeak(prune({ ...g, agents, perType, spawned: spawnedN }, now))
}

/** The toasts owed for what went over a limit between `before` and `after`: once per crossing. */
export function crossings(before: Gov, after: Gov): string[] {
  const s = after.settings
  const out: string[] = []
  const rb = running(before).length
  const ra = running(after).length
  if (rb <= s.maxConcurrent && ra > s.maxConcurrent) {
    out.push(`agent-governor: ${ra} subagents running (limit ${s.maxConcurrent})${s.caps ? '; new spawns will ask first' : ''}`)
  }
  for (const a of Object.values(after.agents)) {
    const tb = before.agents[a.id]?.tokens ?? 0
    if (tb <= s.agentBudget && a.tokens > s.agentBudget) {
      out.push(`agent-governor: ${a.label} used ${fmtTok(a.tokens)} tokens (budget ${fmtTok(s.agentBudget)})${s.caps ? '; its next tool call is denied' : ''}`)
    }
  }
  if (before.sessionTokens <= s.sessionBudget && after.sessionTokens > s.sessionBudget) {
    out.push(`agent-governor: subagents used ${fmtTok(after.sessionTokens)} tokens this session (budget ${fmtTok(s.sessionBudget)})`)
  }
  return out
}

/** What is over a limit now, among the running agents. */
export function warnings(g: Gov): string[] {
  const s = g.settings
  const run = running(g)
  const out: string[] = []
  if (run.length > s.maxConcurrent) out.push(`${run.length} > ${s.maxConcurrent} running`)
  const over = run.filter(a => a.tokens > s.agentBudget).sort((a, b) => b.tokens - a.tokens)
  if (over.length > 0) out.push(`${over[0].label} ${fmtTok(over[0].tokens)} > ${fmtTok(s.agentBudget)}${over.length > 1 ? ` (+${over.length - 1})` : ''}`)
  if (g.sessionTokens > s.sessionBudget) out.push(`session ${fmtTok(g.sessionTokens)} > ${fmtTok(s.sessionBudget)}`)
  return out
}

/** The band's row while agents run; null when there is nothing to show. */
export function bandRow(g: Gov): { text: string; warnings: string[] } | null {
  const n = running(g).length
  if (n === 0) return null
  return { text: `agents ${n} running · peak ${g.peak} · ${fmtTok(g.sessionTokens)} tok`, warnings: warnings(g) }
}

export function statusText(g: Gov, now: number): string {
  const s = g.settings
  const run = running(g)
  const routes = Object.entries(s.routes)
  const top = Object.values(g.agents)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)
  const lines = [
    `agent-governor: ${s.caps ? 'caps ON (asks before over-limit spawns, stops over-budget agents)' : 'watch and warn only'}`,
    `Running ${run.length} · peak ${g.peak} · spawned ${g.spawned} · subagent tokens ${fmtTok(g.sessionTokens)} of ${fmtTok(s.sessionBudget)}`,
    `Limits: ${s.maxConcurrent} concurrent · ${fmtTok(s.agentBudget)} per agent · ${fmtTok(s.sessionBudget)} per session`,
    `Routes: ${routes.length ? routes.map(([t, m]) => `${t}=${m}`).join(', ') : 'none'}`,
  ]
  const warn = warnings(g)
  if (warn.length) lines.push(`Over: ${warn.join(' · ')}`)
  if (top.length) {
    lines.push('Top agents by tokens:')
    for (const a of top) {
      const when = a.isRunning ? `running ${Math.round((now - a.startedAt) / 60000)}m` : 'done'
      lines.push(`  ${a.label}  ${fmtTok(a.tokens)}  ${when}  ${a.description}`)
    }
  }
  lines.push('Commands: /governor max N | budget N | session N | caps on|off | route <type>=<model>|off')
  return lines.join('\n')
}

export type Command =
  | { kind: 'status' }
  | { kind: 'set'; key: 'maxConcurrent' | 'agentBudget' | 'sessionBudget'; value: number }
  | { kind: 'caps'; isOn: boolean }
  | { kind: 'route'; type: string; model: string | null }
  | { kind: 'routes-off' }
  | { kind: 'error'; text: string }

const KEYS = { max: 'maxConcurrent', budget: 'agentBudget', session: 'sessionBudget' } as const

export function parseCommand(args: string): Command {
  const [word = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const arg = rest.join(' ')
  const verb = word.toLowerCase()
  if (verb === '' || verb === 'status') return { kind: 'status' }
  if (verb === 'max' || verb === 'budget' || verb === 'session') {
    const value = parseCount(arg)
    return value === null ? { kind: 'error', text: `/governor ${verb} takes a positive number (e.g. ${verb === 'max' ? '6' : '300k'}).` } : { kind: 'set', key: KEYS[verb], value }
  }
  if (verb === 'caps') {
    if (/^on$/i.test(arg)) return { kind: 'caps', isOn: true }
    if (/^off$/i.test(arg)) return { kind: 'caps', isOn: false }
    return { kind: 'error', text: '/governor caps takes on or off.' }
  }
  if (verb === 'route') {
    if (/^off$/i.test(arg)) return { kind: 'routes-off' }
    const usage = '/governor route takes <type>=<model> (e.g. Explore=sonnet), <type>=off, or off; the model is sonnet, opus, haiku, fable or a full claude- id.'
    const m = /^([^=\s]+)=(\S*)$/.exec(arg)
    if (!m) return { kind: 'error', text: usage }
    const [, type = '', given = ''] = m
    if (!given || given.toLowerCase() === 'off') return { kind: 'route', type, model: null }
    const model = modelOf(given)
    return model ? { kind: 'route', type, model } : { kind: 'error', text: `"${given}" is not a model. ${usage}` }
  }
  return { kind: 'error', text: `Unknown /governor command "${word}". Try: /governor, max N, budget N, session N, caps on|off, route <type>=<model>|off.` }
}
