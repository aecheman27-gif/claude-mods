import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Family } from '../types'

// Picks the model per prompt with local rules, no model calls: quick questions
// to Haiku, writing and explaining to Sonnet, building and fixing to Opus. It
// rewrites the main loop's requests for that one turn (turn.step), so /model
// keeps the person's own pick and subagents keep theirs. A Fable session is the
// person's deliberate pick and is never rerouted.
// The conversation always goes whole to the other model; its prompt cache does
// not (each model keeps its own), so the other model re-reads the chat at the
// cache-write price. It switches only where that costs little: the other
// model's cache is still warm, the current one's went cold anyway, Haiku under
// haikuUnderTokens (its cheap tier), Opus under switchUnderTokens. Sonnet with
// Opus's cache warm re-reads at ~20x the price of staying, so it waits.
// $.state, $.store, $.clock, $.session.usage, $.prompt.submit and $.ui only: no
// files, network, processes or model calls.

const last = atom({ plugin: 'auto-model', key: 'last' } as const, null)
// family -> when the main loop last sent it a request this session: its cache is warm for CACHE_MS after
const lastUsed = atom({ plugin: 'auto-model', key: 'lastUsed' } as const, {})

export type Tier = 'quick' | 'medium' | 'heavy' | 'keep'

const ID: Record<Family, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }
const TARGET: Record<Exclude<Tier, 'keep'>, Family> = { quick: 'haiku', medium: 'sonnet', heavy: 'opus' }
// a person's prompt: typed, from a phone, or a plugin's button (next-steps); not a peer, a schedule or a notification
const ROUTED = new Set(['composer', 'bridge', 'plugin'])
const DEFAULT_LIMIT = 50_000
// Haiku 5.5 bills a prompt of 100K tokens or fewer at its low tier, and counts the same text as ~30% more tokens
const DEFAULT_HAIKU_LIMIT = 75_000
const HAIKU_TOKENS = 1.3
const HAIKU_TIER = 100_000
// Claude Code writes the cache with the 1-hour TTL (as cache-tax counts it)
const CACHE_MS = 60 * 60 * 1000
// $ per million input tokens, list prices September 2026: [cache read, 1-hour cache write]; Haiku's low tier first
const PRICE: Record<Family, { read: number; write: number; overRead?: number; overWrite?: number }> = {
  opus: { read: 0.2, write: 8 },
  sonnet: { read: 0.2, write: 4 },
  haiku: { read: 0.01, write: 0.2, overRead: 0.05, overWrite: 1 },
}
const QUICK_MAX = 160
const LONG_MIN = 600

const HEAVY =
  /\b(?:build|built|implement|create|scaffold|refactor|debug|fix|rewrite|migrate|optimi[sz]e|architect|design|plan|planning|research|investigate|analy[sz]e|audit|review|deploy|install|configure|set ?up|test|benchmark|profile)(?:s|es|ed|d|ing)?\b/i
const WRITE_THING =
  /\b(?:write|make)\b.{0,40}\b(?:script|function|program|app|dashboard|website|page|component|tests?|class|module|plugin|mod|query|regex|code)\b/i
const MEDIUM =
  /\b(?:explain|why|summari[sz]e|compare|draft|translate|describe|outline|brainstorm|suggest|recommend|improve|polish|reword|proofread|rephrase)(?:s|es|ed|d|ing)?\b|\bhow (?:do|does|did|would|should|can|could)\b/i
const QUICK_START = /^(?:what(?:'s|s)?|how (?:many|much|long|old|big)|when|where|who|which|is|are|was|were|does|do|did|has|have|list|show|count|check|tell me|find)\b/i

/** The prompt's tier and the signal that set it. 'keep' runs it on the session's own model. */
export function tierOf(text: string, hasAttachments = false): { tier: Tier; why: string } {
  const t = text.trim()
  if (hasAttachments) return { tier: 'heavy', why: 'has an attachment' }
  if (t.includes('```')) return { tier: 'heavy', why: 'has code' }
  if (t.length > LONG_MIN) return { tier: 'heavy', why: 'long prompt' }
  const heavy = HEAVY.exec(t) ?? WRITE_THING.exec(t)
  if (heavy) return { tier: 'heavy', why: `"${heavy[0].toLowerCase()}"` }
  const medium = MEDIUM.exec(t)
  if (medium) return { tier: 'medium', why: `"${medium[0].toLowerCase()}"` }
  if (t.length <= QUICK_MAX && !t.includes('\n') && (QUICK_START.test(t) || t.endsWith('?'))) return { tier: 'quick', why: 'quick question' }
  // "yes", "push it", "do the next one": a follow-up carries on the task on the model it was on
  return { tier: 'keep', why: 'follow-up or no clear signal' }
}

export function familyOf(model: string): Family | 'fable' | undefined {
  const m = model.toLowerCase()
  if (m.includes('fable')) return 'fable'
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return undefined
}

const k = (n: number) => `${Math.round(n / 1000)}k`
const money = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`

/** What one request's input costs on `family` over `tokens` of context (counted as Opus counts them), its cache warm or not. */
export function inputCost(family: Family, tokens: number, isWarm: boolean): number {
  const p = PRICE[family]
  if (family !== 'haiku') return (tokens / 1e6) * (isWarm ? p.read : p.write)
  const own = tokens * HAIKU_TOKENS
  const over = own > HAIKU_TIER
  return (own / 1e6) * (isWarm ? (over ? p.overRead! : p.read) : over ? p.overWrite! : p.write)
}

export type Cache = {
  /** the context now, in tokens; undefined when the engine has no reading */
  tokens?: number
  now: number
  /** family -> when the main loop last used it */
  lastUsed: Record<string, number>
  haikuLimit: number
  opusLimit: number
}

/** Which family a turn runs on (`family` absent: the session's own model) and the line /automodel shows. */
export function decide(tier: Tier, model: string, c: Cache): { family?: Family; note: string } {
  const base = familyOf(model)
  if (base === undefined) return { note: `kept ${model}: not a model auto-model knows` }
  if (base === 'fable') return { note: 'kept fable: your own pick' }
  if (tier === 'keep') return { note: `kept ${base}` }
  const target = TARGET[tier]
  if (target === base) return { note: `kept ${base}, the right fit` }
  const isWarm = (f: string) => c.now - (c.lastUsed[f] ?? -Infinity) < CACHE_MS
  const tokens = c.tokens ?? 0
  const baseWarm = isWarm(base)
  const targetWarm = isWarm(target)
  const cost = ` (input ≈ ${money(inputCost(target, tokens, targetWarm))} vs ${money(inputCost(base, tokens, baseWarm))} staying)`
  const go = (why: string) => ({ family: target, note: `${target} instead of ${base}: ${why}${cost}` })
  if (targetWarm) return go(`${target}'s cache is still warm`)
  if (!baseWarm) return go(`${base}'s cache was cold too, so staying would re-read the chat as well`)
  if (target === 'haiku' && tokens <= c.haikuLimit) return go(`under ${k(c.haikuLimit)} tokens a Haiku re-read costs about what staying does`)
  if (target === 'opus' && tokens <= c.opusLimit) return go(`under the ${k(c.opusLimit)} switch limit`)
  if (target === 'sonnet') return { note: `kept ${base}: its cache is warm, and Sonnet would re-read the chat cold${cost}` }
  const limit = target === 'haiku' ? c.haikuLimit : c.opusLimit
  return { note: `kept ${base}: the context (${k(tokens)}) is past the ${k(limit)} limit for ${target}${cost}` }
}

type Plan = { tier: Tier; why: string; text: string; isDecided: boolean; family?: Family; base?: string }

const isOff = async ($: EngineInterface) => (await $.store.get('isOff')) === true

export const register: Register = (on, options) => {
  const setting = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback)
  const opusLimit = setting(options?.switchUnderTokens, DEFAULT_LIMIT)
  const haikuLimit = setting(options?.haikuUnderTokens, DEFAULT_HAIKU_LIMIT)
  let pending: { tier: Tier; why: string; text: string } | undefined
  let note = 'no prompt seen yet'
  const plans = new Map<string, Plan>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'automodel',
      description: 'Auto Model: picks Haiku, Sonnet or Opus per prompt (status, on, off)',
      argumentHint: '[status | on | off]',
      immediate: true,
    })
    return next(e)
  })

  // Read the prompt before it enters: its turn starts inside next(e).
  on('prompt.submit', async ($, e, next) => {
    if (e.turnId === undefined) {
      void update($, last, () => null).catch(() => undefined)
      pending = ROUTED.has(e.origin.kind) && !(await isOff($)) ? { ...tierOf(e.text, (e.attachments?.length ?? 0) > 0), text: e.text } : undefined
    }
    return next(e)
  }).catch(($, e, next) => {
    // never hold a prompt back: it runs on the session's own model
    pending = undefined
    return next(e)
  })

  // A prompt this plugin submits (Redo) skips its own prompt.submit hook: no pending, so it runs on the session's model.
  on('turn.start', async ($, e, next) => {
    const p = pending
    pending = undefined
    if (p && p.tier !== 'keep') plans.set(e.turnId, { ...p, isDecided: false })
    else if (p) note = `kept your model (${p.why})`
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // a subagent's requests carry its own transcript, not the main loop's cached one
    if (e.agentId !== undefined) return yield* next(e)
    const plan = plans.get(e.turnId)
    try {
      const now = await $.clock.now()
      if (plan && !plan.isDecided) {
        plan.isDecided = true
        const tokens = await $.session.usage().then(
          u => u.context.tokens,
          () => undefined,
        )
        const d = decide(plan.tier, e.model, { tokens, now, lastUsed: await read($, lastUsed), haikuLimit, opusLimit })
        note = d.note
        if (d.family) {
          plan.family = d.family
          plan.base = familyOf(e.model)
          void $.ui.toast(`auto-model: ${d.family} for this one (${plan.why}). /automodel off to stop`)
          void $.ui.status(`auto-model: ${d.family}`)
        }
      }
      // the model this request warms
      const sent = plan?.family ?? familyOf(e.model)
      if (sent) await update($, lastUsed, all => ({ ...all, [sent]: now }))
    } catch {
      // bookkeeping never holds a request back
    }
    if (!plan?.family) return yield* next(e)
    // the model's own default effort: the session's may be one the other model doesn't take
    return yield* next({ ...e, model: ID[plan.family], effort: undefined })
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const plan = e.agentId === undefined ? plans.get(e.turnId) : undefined
    if (plan) {
      plans.delete(e.turnId)
      const { family } = plan
      if (family) {
        void $.ui.status(undefined)
        if (!e.isAborted) await update($, last, () => ({ family, base: plan.base ?? 'your model', why: plan.why, text: plan.text }))
      }
    }
    return done
  })

  on('command.run', { command: 'automodel' }, async ($, e) => {
    const verb = String(e.args ?? '').trim().toLowerCase() || 'status'
    if (verb === 'off') {
      await $.store.set('isOff', true)
      await update($, last, () => null)
      return { text: 'auto-model is off: every prompt runs on your own /model pick. /automodel on to resume.' }
    }
    if (verb === 'on') {
      await $.store.set('isOff', false)
      return {
        text: 'auto-model is on: quick questions go to Haiku, writing and explaining to Sonnet, building and fixing to Opus, when the switch costs little. /automodel status says when.',
      }
    }
    if (verb !== 'status') return { text: 'Usage: /automodel [status | on | off]' }
    const now = await $.clock.now()
    const caches = Object.entries(await read($, lastUsed))
      .sort((a, b) => b[1] - a[1])
      .map(([f, at]) => (now - at < CACHE_MS ? `${f} warm (used ${Math.round((now - at) / 60_000)}m ago)` : `${f} cold`))
    return {
      text: [
        `auto-model: ${(await isOff($)) ? 'off' : 'on'}. The conversation always goes whole to the other model; its prompt cache doesn't, so it switches only when that costs little:`,
        `  the other model's cache is still warm, or yours went cold anyway (new session, or ${CACHE_MS / 3_600_000}h+ idle);`,
        `  Haiku under ${k(haikuLimit)} tokens (haikuUnderTokens in /config), Opus under ${k(opusLimit)} (switchUnderTokens);`,
        '  Sonnet only when your model\'s cache is cold: a cold Sonnet re-read costs ~20x a warm Opus one.',
        `Caches this session: ${caches.length > 0 ? caches.join(', ') : 'none used yet'}.`,
        `Last prompt: ${note}.`,
      ].join('\n'),
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const r = await read($, last)
    if (!r) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const redo = () => {
      void update($, last, () => null)
      void $.prompt.submit({ text: r.text })
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1} width={e.props.bodyColumns}>
          <Box flexShrink={1}>
            <Text wrap="truncate-end">
              <Text color="#a78bfa" bold>
                [AUTO]{' '}
              </Text>
              {r.family} answered that ({r.why}).
            </Text>
          </Box>
          <Button key="redo" label={`Redo with ${r.base}`} onPress={redo} />
          <Button key="dismiss" label="Dismiss" onPress={() => void update($, last, () => null)} />
        </Box>
        {below}
      </Box>
    )
  })
}
