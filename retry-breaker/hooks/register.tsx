import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { Streak } from '../types'

// Warns when the main loop or a subagent keeps retrying the same failing call
// (a busy COM port, a Modbus timeout, a flaky test): after N identical
// failures in a row from one loop, one toast and a row above the prompt.
// Observe only: every result passes through unchanged, nothing is denied.
// $.state, $.store, $.clock and $.agent.list only: no network, processes or model calls.

const streaks = atom({ plugin: 'retry-breaker', key: 'streaks' } as const, {})

const DEFAULT_THRESHOLD = 3
const MAX_LOOPS = 50
const IDLE_MS = 30 * 60_000
const MAX_ROWS = 3
const KEY_MAX = 500
const SHORT_MAX = 60
const ERROR_MAX = 80
const META = new Set(['tool', 'agentId', 'requestMeta', 'tool_use_id'])

const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

const isShell = (tool: string) => tool === 'Bash' || tool === 'PowerShell'

/** The call's identity within its loop and how it is shown. */
export function callOf(e: Record<string, unknown>): { key: string; short: string } {
  const tool = String(e.tool)
  if (isShell(tool)) {
    const command = String(e.command ?? '').replace(/\s+/g, ' ').trim()
    return { key: `${tool}\u0000${command.slice(0, KEY_MAX)}`, short: clip(command, SHORT_MAX) }
  }
  const input = Object.fromEntries(Object.entries(e).filter(([k]) => !META.has(k)))
  const json = stable(input).slice(0, KEY_MAX)
  return { key: `${tool}\u0000${json}`, short: clip(`${tool} ${json}`, SHORT_MAX) }
}

/** The error's first non-empty line, or undefined when the call succeeded. */
export function failureOf(ran: ToolCallResult): string | undefined {
  let text: string
  if (ran.deny !== undefined) text = ran.deny
  else if (ran.isError) text = ran.text ?? (typeof ran.result === 'string' ? ran.result : 'error')
  else return undefined
  const line = text.split(/\r?\n/).find(l => l.trim() !== '') ?? 'error'
  return clip(line, ERROR_MAX)
}

/** One failure counted: the loop's streak grown or restarted, idle ones dropped, at most MAX_LOOPS kept. */
export function counted(
  all: Record<string, Streak>,
  loop: string,
  call: { key: string; short: string; tool: string },
  error: string,
  now: number,
  threshold: number,
): { all: Record<string, Streak>; isCrossed: boolean } {
  const prev = all[loop]
  const same = prev && prev.key === call.key
  const count = same ? prev.count + 1 : 1
  const isCrossed = count >= threshold && !(same && prev.isShown)
  const streak: Streak = {
    key: call.key,
    tool: call.tool,
    short: call.short,
    count,
    lastError: error,
    lastAt: now,
    ...(same && prev.label ? { label: prev.label } : {}),
    isShown: count >= threshold || Boolean(same && prev.isShown),
    isDismissed: Boolean(same && prev.isDismissed),
  }
  const kept = Object.entries({ ...all, [loop]: streak })
    .filter(([, s]) => now - s.lastAt <= IDLE_MS)
    .sort((a, b) => b[1].lastAt - a[1].lastAt)
    .slice(0, MAX_LOOPS)
  return { all: Object.fromEntries(kept), isCrossed }
}

async function labelOf($: EngineInterface, agentId: string | undefined): Promise<string> {
  if (!agentId) return 'Claude'
  try {
    const a = (await $.agent.list()).find(x => x.id === agentId)
    const name = a ? clip(a.description || a.type || '', 40) : ''
    if (name) return name
  } catch {
    // no roster here: fall back to the id
  }
  return `agent ${agentId.slice(0, 8)}`
}

const thresholdOf = async ($: EngineInterface) => {
  const n = Number(await $.store.get('threshold'))
  return Number.isInteger(n) && n >= 2 ? n : DEFAULT_THRESHOLD
}
const isOff = async ($: EngineInterface) => (await $.store.get('isOff')) === true

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'retry-breaker',
      description: 'Repeated-failure warnings: status, threshold N (default 3), off, on (retry-breaker)',
      argumentHint: '[threshold N | off | on]',
      immediate: true,
    })
    return next(e)
  })

  // Observer: runs the call first, then counts; whatever happens here, the result goes back unchanged.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (await isOff($)) return ran
    const loop = e.agentId ?? 'main'
    const error = failureOf(ran)
    if (error === undefined) {
      if ((await read($, streaks))[loop]) {
        await update($, streaks, all => {
          const { [loop]: _gone, ...rest } = all
          return rest
        })
      }
      return ran
    }
    const call = { ...callOf(e as Record<string, unknown>), tool: String(e.tool) }
    const now = await $.clock.now()
    const threshold = await thresholdOf($)
    let isCrossed = false
    await update($, streaks, all => {
      const r = counted(all, loop, call, error, now, threshold)
      isCrossed = r.isCrossed
      return r.all
    })
    if (isCrossed) {
      const label = await labelOf($, e.agentId)
      await update($, streaks, all => (all[loop]?.key === call.key ? { ...all, [loop]: { ...all[loop], label } } : all))
      const count = (await read($, streaks))[loop]?.count ?? threshold
      $.ui.toast(`retry-breaker: ${label} failed the same ${call.tool} ${count}× in a row: ${call.short}`)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'retry-breaker' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const verb = (words[0] ?? 'status').toLowerCase()
    if (verb === 'off') {
      await $.store.set('isOff', true)
      await update($, streaks, () => ({}))
      return { text: 'retry-breaker is off: repeated failures are no longer tracked. /retry-breaker on to resume.' }
    }
    if (verb === 'on') {
      await $.store.set('isOff', false)
      return { text: `retry-breaker is on: warns after ${await thresholdOf($)} identical failures in a row.` }
    }
    if (verb === 'threshold') {
      const n = Number(words[1])
      if (!Number.isInteger(n) || n < 2 || n > 50) return { text: 'Usage: /retry-breaker threshold N, N a whole number from 2 to 50.' }
      await $.store.set('threshold', n)
      return { text: `retry-breaker: warns after ${n} identical failures in a row.` }
    }
    if (verb !== 'status') return { text: 'Usage: /retry-breaker [status | threshold N | off | on]' }
    const off = await isOff($)
    const threshold = await thresholdOf($)
    const list = Object.entries(await read($, streaks)).sort((a, b) => b[1].lastAt - a[1].lastAt)
    const head = `retry-breaker: ${off ? 'off' : 'on'}, threshold ${threshold}`
    if (list.length === 0) return { text: `${head}. No failing streaks.` }
    const who = (loop: string, s: Streak) => s.label ?? (loop === 'main' ? 'Claude' : `agent ${loop.slice(0, 8)}`)
    const rows = list.map(([loop, s]) => `  ${who(loop, s)}: ${s.short} failed ${s.count}× (last error: ${s.lastError})${s.isDismissed ? ' [dismissed]' : ''}`)
    return { text: [`${head}. Active streaks:`, ...rows].join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const all = await read($, streaks)
    const shown = Object.entries(all)
      .filter(([, s]) => s.isShown && !s.isDismissed)
      .sort((a, b) => b[1].lastAt - a[1].lastAt)
    if (shown.length === 0) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const dismiss = (loop: string, key: string) => () =>
      void update($, streaks, cur => (cur[loop]?.key === key ? { ...cur, [loop]: { ...cur[loop], isDismissed: true } } : cur))
    const extra = shown.length - MAX_ROWS
    const mine = (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        {shown.slice(0, MAX_ROWS).map(([loop, s]) => (
          <Box key={`row-${loop}`} flexDirection="row" columnGap={1}>
            <Box flexShrink={1}>
              <Text wrap="truncate-end">
                <Text color="#f59e0b" bold>
                  [LOOP]{' '}
                </Text>
                {s.label ?? 'Claude'}: {s.short} failed {s.count}× (last error: {s.lastError})
              </Text>
            </Box>
            <Button key={`dismiss-${loop}`} label="Dismiss" onPress={dismiss(loop, s.key)} />
          </Box>
        ))}
        {extra > 0 ? <Text dimColor>+{extra} more (/retry-breaker)</Text> : null}
      </Box>
    )
    return (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })
}
