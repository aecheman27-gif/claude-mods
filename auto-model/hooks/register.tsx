import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheUse, Family } from '../types'

// Picks the model per prompt with local rules, no model calls: quick questions
// to Haiku, writing and explaining to Sonnet, building and fixing to Opus. It
// rewrites the main loop's requests for that one turn (turn.step), so /model
// keeps the person's own pick and subagents keep theirs. A Fable session is the
// person's deliberate pick and is never rerouted.
// The conversation always goes whole to the other model; its prompt cache does
// not (each model keeps its own), so the other model re-reads at the
// cache-write price whatever its cache lacks: all of the chat when it is cold,
// what was added since its last use when it is warm. It switches only where
// that costs little: the other model's cache misses no more of the chat than
// yours, yours went cold anyway, Haiku under haikuUnderTokens (its cheap tier),
// Opus re-reading under switchUnderTokens. Sonnet with Opus's cache warm
// re-reads at ~20x the price of staying, so it waits.
// Only Anthropic's own model ids are routed (not Bedrock, Vertex or a gateway's
// names), only on the session's model (a fallback the engine retries on is left
// alone), and a routed turn that ends in an error or a refusal stops routing
// for the rest of the session.
// $.state, $.store, $.clock, $.session (usage, model, turns), $.prompt.submit
// and $.ui only: no files, network, processes or model calls.

const last = atom({ plugin: 'auto-model', key: 'last' } as const, null)
// family -> the main loop's last request to it this session: when (its cache is warm for CACHE_MS after) and the context it cached
const caches = atom({ plugin: 'auto-model', key: 'caches' } as const, {})

export type Tier = 'quick' | 'medium' | 'heavy' | 'keep'

const ID: Record<Family, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }
// the ids ID's are siblings of; a provider's own spelling (Bedrock's us.anthropic.claude-…, Vertex's …@date, a gateway alias) is not rewritten
const FIRST_PARTY = /^claude-(?:opus|sonnet|haiku|fable)-[0-9][a-z0-9-]*(?:\[\w+\])?$/
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
// "find the old logs and delete them", "check COM3 and reset the board": a request that changes something, not a question
const ACTION =
  /\b(?:delete|remove|reset|restart|reboot|shut ?down|run|send|push|pull|write|flash|kill|stop|start|launch|execute|move|rename|overwrite|upload|deploy|commit|merge|rebase|revert|restore|clean|wipe|erase|purge|drop|truncate|format|install|uninstall|reinstall|upgrade|downgrade|enable|disable|change|set|update|edit|apply|publish|cancel|archive|calibrate|trigger)(?:s|es|ed|d|ing)?\b/i

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
  if (t.length <= QUICK_MAX && !t.includes('\n') && (QUICK_START.test(t) || t.endsWith('?'))) {
    // Haiku would carry it out with every tool: an action stays on the person's own model
    const action = ACTION.exec(t)
    if (action) return { tier: 'keep', why: `"${action[0].toLowerCase()}" asks for an action` }
    return { tier: 'quick', why: 'quick question' }
  }
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

/**
 * What one request's input costs on `family` over `tokens` of context (counted as Opus counts them):
 * the `cached` part its warm cache holds at the read price, the rest at the write price.
 */
export function inputCost(family: Family, tokens: number, cached: number): number {
  const p = PRICE[family]
  const hit = Math.min(cached, tokens)
  if (family !== 'haiku') return (hit * p.read + (tokens - hit) * p.write) / 1e6
  const over = tokens * HAIKU_TOKENS > HAIKU_TIER
  return ((hit * (over ? p.overRead! : p.read) + (tokens - hit) * (over ? p.overWrite! : p.write)) * HAIKU_TOKENS) / 1e6
}

export type Cache = {
  /** the context now, in tokens; undefined when the engine has no reading */
  tokens?: number
  now: number
  /** family -> the main loop's last request to it: when, and the context it cached */
  caches: Record<string, CacheUse>
  haikuLimit: number
  opusLimit: number
}

/** Which family a turn runs on (`family` absent: the session's own model) and the line /automodel shows. */
export function decide(tier: Tier, model: string, c: Cache): { family?: Family; note: string } {
  const base = familyOf(model)
  if (base === undefined || !FIRST_PARTY.test(model)) return { note: `kept ${model}: auto-model routes only Anthropic's own model ids (claude-opus-…)` }
  if (base === 'fable') return { note: 'kept fable: your own pick' }
  if (tier === 'keep') return { note: `kept ${base}` }
  const target = TARGET[tier]
  if (target === base) return { note: `kept ${base}, the right fit` }
  const tokens = c.tokens ?? 0
  const isWarm = (f: string) => c.now - (c.caches[f]?.at ?? -Infinity) < CACHE_MS
  // how much of the chat a warm cache still holds: what its last use cached
  const held = (f: string) => (isWarm(f) ? Math.min(c.caches[f]?.tokens ?? 0, tokens) : 0)
  // what each would re-read at the write price: the target by switching, your model by staying
  const fresh = tokens - held(target)
  const stale = tokens - held(base)
  const cost = ` (input ≈ ${money(inputCost(target, tokens, held(target)))} vs ${money(inputCost(base, tokens, held(base)))} staying)`
  const go = (why: string) => ({ family: target, note: `${target} instead of ${base}: ${why}${cost}` })
  if (isWarm(target) && fresh <= stale) return go(`${target}'s cache is still warm`)
  if (!isWarm(base)) return go(`${base}'s cache was cold too, so staying would re-read the chat as well`)
  if (target === 'haiku' && tokens <= c.haikuLimit) return go(`under ${k(c.haikuLimit)} tokens a Haiku re-read costs about what staying does`)
  if (target === 'opus' && fresh <= c.opusLimit) return go(`under the ${k(c.opusLimit)} switch limit`)
  const missed = fresh < tokens ? `${k(fresh)} of the chat` : 'the chat'
  if (target === 'sonnet') return { note: `kept ${base}: its cache is warm, and Sonnet would re-read ${missed} cold${cost}` }
  if (target === 'haiku') return { note: `kept ${base}: the context (${k(tokens)}) is past the ${k(c.haikuLimit)} limit for haiku${cost}` }
  return { note: `kept ${base}: opus would re-read ${missed} cold, past the ${k(c.opusLimit)} switch limit${cost}` }
}

type Plan = {
  tier: Tier
  why: string
  text: string
  isDecided: boolean
  family?: Family
  base?: string
  /** the session's model as the turn's first request named it: a later step naming another is a fallback, left alone */
  model?: string
  /** the routed model refused a request: the rest of the turn runs as the engine sends it */
  isRefused?: boolean
}

/** The model a step is sent to instead of `model`, if the turn is routed and the step is still on the session's model. */
const routedModel = (plan: Plan | undefined, model: string) => (plan?.family && !plan.isRefused && model === plan.model ? ID[plan.family] : undefined)

const isOff = async ($: EngineInterface) => (await $.store.get('isOff')) === true

export const register: Register = (on, options) => {
  const setting = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback)
  const opusLimit = setting(options?.switchUnderTokens, DEFAULT_LIMIT)
  const haikuLimit = setting(options?.haikuUnderTokens, DEFAULT_HAIKU_LIMIT)
  let pending: { tier: Tier; why: string; text: string } | undefined
  let note = 'no prompt seen yet'
  // why routing stopped for the rest of the session: a switched turn ended in an error or a refusal
  let halted: string | undefined
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
      pending = ROUTED.has(e.origin.kind) && !halted && !(await isOff($)) ? { ...tierOf(e.text, (e.attachments?.length ?? 0) > 0), text: e.text } : undefined
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
      const tokens = await $.session.usage().then(
        u => u.context.tokens,
        () => undefined,
      )
      if (plan && !plan.isDecided) {
        plan.isDecided = true
        const base = familyOf(e.model)
        const own = familyOf(await $.session.model().catch(() => ''))
        if (own !== undefined && base !== own) note = `left ${e.model} alone: a fallback for your ${own}`
        else {
          // a resumed chat (or one auto-model joined late) has no record of your model's cache: count it warm from now
          if (base && (await read($, caches))[base] === undefined && (await $.session.turns().catch(() => 0)) > 1)
            await update($, caches, all => ({ ...all, [base]: { at: now, tokens: tokens ?? 0 } }))
          const d = decide(plan.tier, e.model, { tokens, now, caches: await read($, caches), haikuLimit, opusLimit })
          note = d.note
          if (d.family) {
            plan.family = d.family
            plan.base = base
            plan.model = e.model
            void $.ui.toast(`auto-model: ${d.family} for this one (${plan.why}). /automodel off to stop`)
            void $.ui.status(`auto-model: ${d.family}`)
          }
        }
      }
      // the model this request warms, and the context it caches
      const sent = familyOf(routedModel(plan, e.model) ?? e.model)
      if (sent) await update($, caches, all => ({ ...all, [sent]: { at: now, tokens: tokens ?? all[sent]?.tokens ?? 0 } }))
    } catch {
      // bookkeeping never holds a request back
    }
    const model = routedModel(plan, e.model)
    if (!plan || !model) return yield* next(e)
    // the model's own default effort: the session's may be one the other model doesn't take
    const r = yield* next({ ...e, model, effort: undefined })
    // the engine retries a refusal on a fallback model: never force the refused one back
    if (r.stopReason === 'refusal') plan.isRefused = true
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const plan = e.agentId === undefined ? plans.get(e.turnId) : undefined
    if (plan) {
      plans.delete(e.turnId)
      const { family } = plan
      if (family) {
        void $.ui.status(undefined)
        if (e.reason === 'error' || e.reason === 'refusal') {
          // the model may be closed to this account or provider: no more switching this session
          halted = `a turn on ${family} ended with ${e.reason === 'error' ? 'an API error' : 'a refusal'}`
          void $.ui.toast(`auto-model: ${halted}, so every prompt runs on your own model for the rest of this session. /automodel status`)
        } else if (!e.isAborted) await update($, last, () => ({ family, base: plan.base ?? 'your model', why: plan.why, text: plan.text }))
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
      halted = undefined
      return {
        text: 'auto-model is on: quick questions go to Haiku, writing and explaining to Sonnet, building and fixing to Opus, when the switch costs little. /automodel status says when.',
      }
    }
    if (verb !== 'status') return { text: 'Usage: /automodel [status | on | off]' }
    const now = await $.clock.now()
    const used = Object.entries(await read($, caches))
      .sort((a, b) => b[1].at - a[1].at)
      .map(([f, u]) => (now - u.at < CACHE_MS ? `${f} warm (${k(u.tokens)}, used ${Math.round((now - u.at) / 60_000)}m ago)` : `${f} cold`))
    const state = (await isOff($)) ? 'off' : halted ? `paused for the rest of this session: ${halted} (/automodel on resumes)` : 'on'
    return {
      text: [
        `auto-model: ${state}. The conversation always goes whole to the other model; its prompt cache doesn't, so it switches only when that costs little:`,
        `  the other model's cache misses no more of the chat than yours (a cache holds the chat as of its last use, for ${CACHE_MS / 3_600_000}h), or yours went cold anyway (new session, or ${CACHE_MS / 3_600_000}h+ idle; a resumed chat counts as warm);`,
        `  Haiku under ${k(haikuLimit)} tokens (haikuUnderTokens in /config), Opus when it would re-read under ${k(opusLimit)} cold (switchUnderTokens);`,
        '  Sonnet only when your model\'s cache is cold: a cold Sonnet re-read costs ~20x a warm Opus one.',
        "  Only Anthropic's own model ids, only on your session's model (a fallback is left alone); an error or refusal on a switched turn pauses it.",
        `Caches this session: ${used.length > 0 ? used.join(', ') : 'none used yet'}.`,
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
      void $.prompt.submit({ text: r.text, asUser: true })
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
