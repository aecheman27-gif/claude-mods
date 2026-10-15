import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Card, Step } from '../types'

// Claude ends a turn by offering 2-4 follow-ups through the next_steps tool;
// they show as buttons above the prompt, each with the whole prompt it sends
// beside it, and a click sends that follow-up as your own prompt: a short label
// can never hide what a click says. The card goes away as soon as any prompt
// is sent. The
// model reads one extra line of system prompt and the tool's description; the
// mod itself makes no model calls, no network, no processes.

const TOOL = 'mcp__next-steps__next_steps'
const MAX_STEPS = 4
const MAX_LABEL = 40
// short enough to read whole beside its button
const MAX_PROMPT = 200
const card = atom({ plugin: 'next-steps', key: 'card' } as const, null)

const HINT = {
  id: 'next-steps:hint',
  scope: 'session',
  text:
    'When you finish a turn and the user is likely to continue with one of a few clear follow-ups, call the next_steps tool as your last action with 2-4 of them, ' +
    'instead of listing them in prose. Skip it when the work is complete with no obvious follow-up, and use AskUserQuestion instead when you cannot continue without a decision.',
} as const

const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}
// control, zero-width and direction characters: none may hide or reorder the words of a prompt shown as sent
const HIDING = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g

/** The steps the model gave, cleaned, or why they can't be shown. */
export function stepsFrom(input: unknown): Step[] | string {
  const raw = (input as { steps?: unknown }).steps
  if (!Array.isArray(raw) || raw.length === 0) return 'steps must be a non-empty list'
  const steps: Step[] = []
  for (const s of raw.slice(0, MAX_STEPS)) {
    const label = typeof s?.label === 'string' ? clip(s.label, MAX_LABEL) : ''
    const prompt = typeof s?.prompt === 'string' ? s.prompt.replace(HIDING, ' ').replace(/\s+/g, ' ').trim() : ''
    if (!label || !prompt) return 'each step needs a label and a prompt'
    // cut, it would send less than it asks: the model writes a shorter one
    if (prompt.length > MAX_PROMPT) return `each prompt must be at most ${MAX_PROMPT} characters: it is shown in full beside its button`
    steps.push({ label, prompt })
  }
  return steps
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'next_steps',
      description:
        'Offer the user 2-4 likely follow-ups as clickable buttons above the prompt. Call it as the last action of a turn, after your reply. ' +
        'Each button shows its whole prompt beside it, and a click sends exactly that prompt as if the user typed it; the buttons disappear when the user sends anything. Not for blocking questions (use AskUserQuestion).',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Optional short heading, e.g. "What next?"' },
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_STEPS,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: `Button text, a few words (at most ${MAX_LABEL} characters).` },
                prompt: {
                  type: 'string',
                  maxLength: MAX_PROMPT,
                  description: `What gets sent when clicked, shown in full beside the button (at most ${MAX_PROMPT} characters), written as the user asking you, e.g. "Run the tests and fix any failures".`,
                },
              },
              required: ['label', 'prompt'],
            },
          },
        },
        required: ['steps'],
      },
      // in the prompt's tool list: offered at the end of most turns, behind ToolSearch it would cost a round trip
      isDeferred: false,
    })
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId) return { result: 'ignored: only the main conversation offers next steps' }
    const steps = stepsFrom(e)
    if (typeof steps === 'string') return { deny: `next_steps: ${steps}` }
    const asked = (e as { question?: unknown }).question
    const question = typeof asked === 'string' ? clip(asked, 80) : ''
    const now: Card = question ? { question, steps } : { steps }
    await update($, card, () => now)
    return { result: `shown: ${steps.length} button${steps.length === 1 ? '' : 's'} above the prompt` }
  }).catch(() => ({ result: 'not shown: the next-steps card failed; carry on without it' }))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL)) return composed
    return { ...composed, sections: [...composed.sections, HINT] }
  }).catch(($, e, next) => next(e))

  // Anything sent, typed or clicked, answers the card.
  on('prompt.submit', async ($, e, next) => {
    await update($, card, () => null).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const c = await read($, card)
    if (!c || e.props.hasSurvey || e.props.isWorking) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const send = (s: Step) => () =>
      void update($, card, () => null)
        .then(() => $.prompt.submit({ text: s.prompt, asUser: true }))
        .catch(err => $.ui.toast(`next-steps: could not send: ${err instanceof Error ? err.message : String(err)}`))
    // each button with the whole prompt it sends beside it: the label can't say one thing and the click another
    const mine = (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Box flexDirection="row" columnGap={1}>
          <Box flexShrink={1}>
            <Text wrap="truncate-end">
              <Text color="#38bdf8" bold>
                [NEXT]{' '}
              </Text>
              {c.question ?? 'Pick one, or type your own:'}
            </Text>
          </Box>
          <Button key="dismiss" label="✕" onPress={() => void update($, card, () => null)} />
        </Box>
        {c.steps.map((s, i) => (
          <Box key={`row-${i}`} flexDirection="row" columnGap={1}>
            <Button key={`step-${i}`} label={s.label} variant={i === 0 ? 'primary' : undefined} onPress={send(s)} />
            <Box flexShrink={1}>
              <Text dimColor wrap="wrap">
                {s.prompt}
              </Text>
            </Box>
          </Box>
        ))}
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
