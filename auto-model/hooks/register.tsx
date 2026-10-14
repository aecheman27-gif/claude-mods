import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Family } from '../types'

// Picks the model per prompt with local rules, no model calls: quick questions
// to Haiku, writing and explaining to Sonnet, building and fixing to Opus. It
// rewrites the main loop's requests for that one turn (turn.step), so /model
// keeps the person's own pick and subagents keep theirs. Each model has its
// own prompt cache, so a switch re-reads the whole conversation uncached: it
// only switches while the context is under switchUnderTokens. A Fable session
// is the person's deliberate pick and is never rerouted.
// $.state, $.store, $.session.usage, $.prompt.submit and $.ui only: no files,
// network, processes or model calls.

const last = atom({ plugin: 'auto-model', key: 'last' } as const, null)

export type Tier = 'quick' | 'medium' | 'heavy' | 'keep'

const ID: Record<Family, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }
const TARGET: Record<Exclude<Tier, 'keep'>, Family> = { quick: 'haiku', medium: 'sonnet', heavy: 'opus' }
// a person's prompt: typed, from a phone, or a plugin's button (next-steps); not a peer, a schedule or a notification
const ROUTED = new Set(['composer', 'bridge', 'plugin'])
const DEFAULT_LIMIT = 50_000
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

/** Which family a turn runs on (`family` absent: the session's own model) and the line /automodel shows. */
export function decide(tier: Tier, model: string, tokens: number | undefined, limit: number): { family?: Family; note: string } {
  const base = familyOf(model)
  if (base === undefined) return { note: `kept ${model}: not a model auto-model knows` }
  if (base === 'fable') return { note: 'kept fable: your own pick' }
  if (tier === 'keep') return { note: `kept ${base}` }
  const target = TARGET[tier]
  if (target === base) return { note: `kept ${base}, the right fit` }
  if (tokens !== undefined && tokens > limit)
    return { note: `kept ${base}: the context (${k(tokens)}) is past the ${k(limit)} switch limit, so ${target} would re-read it uncached` }
  return { family: target, note: `${target} instead of ${base}` }
}

type Plan = { tier: Tier; why: string; text: string; isDecided: boolean; family?: Family; base?: string }

const isOff = async ($: EngineInterface) => (await $.store.get('isOff')) === true

export const register: Register = (on, options) => {
  const configured = Number(options?.switchUnderTokens)
  const limit = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_LIMIT
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
    const plan = e.agentId === undefined ? plans.get(e.turnId) : undefined
    if (!plan) return yield* next(e)
    if (!plan.isDecided) {
      plan.isDecided = true
      const tokens = await $.session.usage().then(
        u => u.context.tokens,
        () => undefined,
      )
      const d = decide(plan.tier, e.model, tokens, limit)
      note = d.note
      if (d.family) {
        plan.family = d.family
        plan.base = familyOf(e.model)
        void $.ui.toast(`auto-model: ${d.family} for this one (${plan.why}). /automodel off to stop`)
        void $.ui.status(`auto-model: ${d.family}`)
      }
    }
    if (!plan.family) return yield* next(e)
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
        text: `auto-model is on: quick questions go to Haiku, writing and explaining to Sonnet, building and fixing to Opus, while the context is under ${k(limit)} tokens.`,
      }
    }
    if (verb !== 'status') return { text: 'Usage: /automodel [status | on | off]' }
    return {
      text: [
        `auto-model: ${(await isOff($)) ? 'off' : 'on'}. It switches only while the context is under ${k(limit)} tokens (switchUnderTokens in /config).`,
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
