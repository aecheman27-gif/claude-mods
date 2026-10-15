import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Day, Kind, Period, Report } from '../types'

// /report: what Claude did for you today, this week, month or year. Each
// main-loop turn that ends with an answer is a task: its length, the kind of
// work (by the most telling tool it used), the model that answered and the
// status line's cost across it are added to that day's totals in $.store.
// Time saved and its value are estimates from two settings in /config.
// Observers only: every event passes through unchanged.
// $.state, $.store, $.clock, $.session.usage and $.ui only: no files,
// network, processes or model calls.

const PANE = 'todays-report'
const report = atom({ plugin: 'todays-report', key: 'report' } as const, null)
const PERIODS: Period[] = ['today', 'week', 'month', 'year', 'all']
const PERIOD_DAYS: Record<Period, number> = { today: 1, week: 7, month: 30, year: 365, all: Infinity }
const PERIOD_LABEL: Record<Period, string> = { today: 'Today', week: 'Last 7 days', month: 'Last 30 days', year: 'Last 365 days', all: 'All time' }
const KIND_LABEL: Record<Kind, string> = {
  email: 'Email',
  calendar: 'Calendar',
  code: 'Code',
  docs: 'Documents',
  design: 'Design',
  research: 'Research',
  commands: 'Commands',
  agents: 'Agents',
  reading: 'Reading files',
  other: 'Other tools',
  chat: 'Chat (no tools)',
}
// a task is the most telling kind of tool it used, in this order
const PRIORITY: Kind[] = ['email', 'calendar', 'code', 'docs', 'design', 'research', 'commands', 'agents', 'reading', 'other']
const DOC_EXT = /\.(md|mdx|txt|rtf|docx?|odt|pdf|csv|xlsx?|pptx?|html?)$/i
const BAR = 24
const DEFAULT_MINUTES = 10
const DEFAULT_RATE = 50

/** What kind of work one tool call is. */
export function kindOf(tool: string, input: Record<string, unknown> = {}): Exclude<Kind, 'chat'> {
  if (/gmail|outlook|mail/i.test(tool)) return 'email'
  if (/calendar/i.test(tool)) return 'calendar'
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit')
    return DOC_EXT.test(String(input.file_path ?? input.notebook_path ?? '')) ? 'docs' : 'code'
  if (/docs|drive|notion|confluence|atlassian|artifact/i.test(tool)) return 'docs'
  if (/figma|canva/i.test(tool)) return 'design'
  if (tool === 'WebSearch' || tool === 'WebFetch' || /chrome|playwright|browser/i.test(tool)) return 'research'
  if (tool === 'Bash' || tool === 'PowerShell') return 'commands'
  if (tool === 'Agent' || tool === 'Workflow' || tool === 'SendMessage') return 'agents'
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob' || tool === 'LSP') return 'reading'
  return 'other'
}

/** The task's kind from its tool counts: the first present in PRIORITY, 'chat' with none. */
export function mainKind(counts: Partial<Record<Kind, number>>): Kind {
  return PRIORITY.find(k => (counts[k] ?? 0) > 0) ?? 'chat'
}

export function familyOf(model: string): string {
  return /fable|opus|sonnet|haiku/i.exec(model)?.[0]?.toLowerCase() ?? model
}

const empty = (): Day => ({ tasks: 0, workMs: 0, usd: 0, tokensIn: 0, cachedIn: 0, tokensOut: 0, models: {}, kinds: {} })
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const counts = (v: unknown): Record<string, number> =>
  v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, n]) => [k, num(n)])) : {}

/** A stored day read back whole, whatever an older version or a hand edit left. */
export function dayOf(v: unknown): Day {
  if (!v || typeof v !== 'object') return empty()
  const d = v as Record<string, unknown>
  return {
    tasks: num(d.tasks),
    workMs: num(d.workMs),
    usd: num(d.usd),
    tokensIn: num(d.tokensIn),
    cachedIn: num(d.cachedIn),
    tokensOut: num(d.tokensOut),
    models: counts(d.models),
    kinds: counts(d.kinds),
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
/** YYYY-MM-DD of a clock time, local. */
export const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const shift = (key: string, days: number) => {
  const [y, m, d] = key.split('-').map(Number)
  return dayKey(new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days, 12).getTime())
}
const add = (a: Record<string, number>, b: Record<string, number>) => {
  const out = { ...a }
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n
  return out
}

/** The period's totals over every stored day, with the streak (which looks past the period). */
export function summarize(days: Record<string, Day>, period: Period, today: string): Report {
  const from = PERIOD_DAYS[period] === Infinity ? '' : shift(today, 1 - PERIOD_DAYS[period])
  const keys = Object.keys(days).sort()
  const total = empty()
  let activeDays = 0
  for (const key of keys) {
    if (key < from || key > today) continue
    const d = days[key] ?? empty()
    total.tasks += d.tasks
    total.workMs += d.workMs
    total.usd += d.usd
    total.tokensIn += d.tokensIn
    total.cachedIn += d.cachedIn
    total.tokensOut += d.tokensOut
    total.models = add(total.models, d.models)
    total.kinds = add(total.kinds, d.kinds as Record<string, number>)
    if (d.tasks > 0) activeDays++
  }
  const has = (key: string) => (days[key]?.tasks ?? 0) > 0
  let streak = 0
  for (let key = has(today) ? today : shift(today, -1); has(key); key = shift(key, -1)) streak++
  let best = 0
  let run = 0
  let prev = ''
  for (const key of keys.filter(has)) {
    run = prev && shift(prev, 1) === key ? run + 1 : 1
    best = Math.max(best, run)
    prev = key
  }
  return { ...total, period, activeDays, streak, best, since: keys[0] ?? '' }
}

// 1,234: no Intl in the module's environment to lean on
const grouped = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const money = (n: number) => (n < 100 ? `$${n.toFixed(2)}` : `$${grouped(n)}`)
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
const duration = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`
}
const hours = (h: number) => (h < 10 ? h.toFixed(1) : grouped(h))
const plural = (n: number, one: string) => `${grouped(n)} ${one}${n === 1 ? '' : 's'}`

async function usdNow($: EngineInterface): Promise<number> {
  return $.session.usage().then(
    u => num(u.cost?.usd),
    () => 0,
  )
}

// One read-modify-write of a day at a time in this session: a subagent and the main turn ending together
// would otherwise both read the day before either wrote it, and one's counts would be lost. Two sessions
// ending a turn in the same instant can still lose one task's tally: the store has no compare-and-set,
// and per-session keys would grow it without bound; for a local estimate, that rare loss is accepted.
let recording: Promise<void> = Promise.resolve()

/** Adds to one day's stored totals, after any add already under way. */
function record($: EngineInterface, at: number, change: (d: Day) => Day): Promise<void> {
  const key = `day:${dayKey(at)}`
  const done = recording.then(async () => $.store.set(key, change(dayOf(await $.store.get(key)))))
  recording = done.catch(() => undefined)
  return done
}

async function stored($: EngineInterface): Promise<Record<string, Day>> {
  const keys = (await $.store.keys()).filter(k => k.startsWith('day:'))
  const days: Record<string, Day> = {}
  for (const key of keys) days[key.slice(4)] = dayOf(await $.store.get(key))
  return days
}

/** Totals the period and hands the pane its report. */
async function show($: EngineInterface, period: Period) {
  const today = dayKey(await $.clock.now())
  const r = summarize(await stored($), period, today)
  await update($, report, () => r)
}

export const register: Register = (on, options) => {
  const setting = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback)
  const minutesPerTask = setting(options?.minutesPerTask, DEFAULT_MINUTES)
  const hourlyRate = setting(options?.hourlyRate, DEFAULT_RATE)
  // the main turn now running: the cost when it started, and its tool calls by kind (its subagents' too)
  let turn: { startUsd: number; tools: Partial<Record<Kind, number>> } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'report',
      description: "Today's report: tasks Claude finished, time worked, kinds of work, models, cost, streak, est. time saved",
      argumentHint: '[today | week | month | year | all]',
      immediate: true,
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turn = { startUsd: await usdNow($), tools: {} }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (turn) {
      const kind = kindOf(String(e.tool), e as Record<string, unknown>)
      turn.tools[kind] = (turn.tools[kind] ?? 0) + 1
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const u = e.usage
    const fromUsage = (d: Day): Day =>
      u
        ? {
            ...d,
            tokensIn: d.tokensIn + u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens,
            cachedIn: d.cachedIn + u.cache_read_input_tokens,
            tokensOut: d.tokensOut + u.output_tokens,
          }
        : d
    const at = await $.clock.now()
    // a subagent's run: its tokens count; its cost is in its main turn's, and it is not a task of its own
    if (e.agentId !== undefined) {
      if (u) await record($, at, fromUsage)
      return done
    }
    const t = turn
    turn = undefined
    const usd = t ? Math.max(0, (await usdNow($)) - t.startUsd) : 0
    const isTask = e.reason === 'answer'
    const kind = mainKind(t?.tools ?? {})
    await record($, at, d => {
      const spent: Day = { ...fromUsage(d), usd: d.usd + usd }
      if (!isTask) return spent
      return {
        ...spent,
        tasks: d.tasks + 1,
        workMs: d.workMs + e.durationMs,
        models: u ? add(d.models, { [familyOf(u.model)]: 1 }) : d.models,
        kinds: add(d.kinds as Record<string, number>, { [kind]: 1 }),
      }
    })
    const shown = await read($, report)
    if (shown) await show($, shown.period)
    return done
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'report' }, async ($, e) => {
    const word = String(e.args ?? '').trim().toLowerCase() || 'today'
    const period = PERIODS.find(p => p === word)
    if (!period) return { text: 'Usage: /report [today | week | month | year | all]' }
    await show($, period)
    await $.ui.open({ id: PANE, title: "Today's report", focus: true, closeOnEscape: true })
    const r = await read($, report)
    return { text: r ? `${PERIOD_LABEL[period]}: ${plural(r.tasks, 'task')}, Claude worked ${duration(r.workMs)}.` : 'Report opened.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, report, () => null)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const r = await read($, report)
    if (!r) return <Text dimColor>/report opens it.</Text>
    const saved = (r.tasks * minutesPerTask) / 60
    const rows = (entries: [string, number][]) => {
      const max = Math.max(1, ...entries.map(([, n]) => n))
      const width = Math.max(...entries.map(([label]) => label.length))
      return entries.map(([label, n]) => (
        <Text key={`row-${label}`}>
          {'  '}
          {label.padEnd(width)} <Text color="#7c9cf5">{'█'.repeat(Math.max(1, Math.round((n / max) * BAR)))}</Text> {n}
        </Text>
      ))
    }
    const kinds = Object.entries(r.kinds as Record<string, number>)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]): [string, number] => [KIND_LABEL[k as Kind] ?? k, n])
    const models = Object.entries(r.models)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
    const cachedShare = r.tokensIn > 0 ? Math.round((r.cachedIn / r.tokensIn) * 100) : 0
    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {PERIODS.map(p => (
            <Button key={`p-${p}`} label={p === 'today' ? 'Today' : p[0]!.toUpperCase() + p.slice(1)} variant={p === r.period ? 'primary' : 'secondary'} onPress={() => void show($, p)} />
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>
            {PERIOD_LABEL[r.period]}: {plural(r.tasks, 'task')} · Claude worked {duration(r.workMs)}
            {r.period === 'today' ? '' : ` · on ${plural(r.activeDays, 'day')}`}
          </Text>
          <Text>
            Streak: {plural(r.streak, 'day')} (best {r.best})
          </Text>
          <Text>
            Time saved (estimate): {hours(saved)} h = {plural(r.tasks, 'task')} × {minutesPerTask} min · worth {money(saved * hourlyRate)} at {money(hourlyRate)}/h
          </Text>
          <Text dimColor>
            API-equivalent cost: {money(r.usd)} · {tokens(r.tokensIn)} tokens in ({cachedShare}% from cache), {tokens(r.tokensOut)} out
          </Text>
        </Box>
        {kinds.length > 0 ? (
          <Box flexDirection="column">
            <Text bold>Where it went</Text>
            {rows(kinds)}
          </Box>
        ) : null}
        {models.length > 0 ? (
          <Box flexDirection="column">
            <Text bold>Models</Text>
            {rows(models)}
          </Box>
        ) : null}
        <Text dimColor>
          {r.since ? `Counting since ${r.since}. ` : 'Nothing counted yet: tasks add up as Claude finishes them. '}
          Minutes per task and hourly rate are in /config.
        </Text>
      </Box>
    )
  })
}
