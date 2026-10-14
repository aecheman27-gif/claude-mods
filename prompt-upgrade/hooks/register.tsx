import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, Register } from 'claude-code'

import type { Question, Upgrade } from '../types'

// /improve <prompt> opens a pane: the model asks 2-4 multiple-choice questions
// about the prompt, the person picks, and the model writes a fuller prompt from
// the answers, to run, edit in the prompt box, or copy. Two $.model.complete
// calls per upgrade, only when asked: prompts sent normally are never touched.
// $.state, $.model.complete, $.session.messages, $.prompt and $.ui only: no
// files, network or processes.

const PANE = 'prompt-upgrade'
const view = atom({ plugin: 'prompt-upgrade', key: 'view' } as const, null)
const MAX_QUESTIONS = 4
const MAX_OPTIONS = 5
const CLIP = 120
const SIDE_BY_SIDE = 100

const ASK = [
  'You help a person turn a short request for an AI assistant into a strong prompt.',
  'Ask 2 to 4 multiple-choice questions whose answers would change the result most: the goal, who it is for, scope, format, length, tone, constraints, budget.',
  'Each question has 2 to 4 short options. Do not ask what the request already says. If the request is already specific, ask nothing.',
  'Reply with JSON only, no prose: {"questions":[{"q":"...","options":["...","..."]}]}',
].join('\n')

const WRITE = [
  "Rewrite the person's request as one clear, complete prompt for an AI assistant, using their answers.",
  'Keep their intent and their voice. State the goal, the context, the constraints and the output they want.',
  'Use only what the request and the answers say; leave out what is unknown rather than inventing it.',
  'Reply with the prompt alone: no preamble, no quotes, no notes.',
].join('\n')

const clip = (text: string) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > CLIP ? t.slice(0, CLIP - 1) + '…' : t
}

/** The questions in the model's reply: at most 4, each with 2-5 distinct options; [] when the reply has none that parse. */
export function parseQuestions(reply: string): Question[] {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let data: unknown
  try {
    data = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return []
  }
  const list = (data as { questions?: unknown } | null)?.questions
  if (!Array.isArray(list)) return []
  const out: Question[] = []
  for (const item of list as { q?: unknown; options?: unknown }[]) {
    const text = clip(String(item?.q ?? ''))
    const raw = Array.isArray(item?.options) ? (item.options as unknown[]) : []
    const options = [...new Set(raw.map(o => clip(String(o))))].filter(Boolean).slice(0, MAX_OPTIONS)
    if (text && options.length >= 2) out.push({ id: `q${out.length + 1}`, text, options })
    if (out.length === MAX_QUESTIONS) break
  }
  return out
}

/** What the rewrite reads: the request, then each answered question and the extra note. */
export function writeRequest(v: Pick<Upgrade, 'original' | 'questions' | 'answers' | 'extra'>): string {
  const lines = v.questions.filter(q => v.answers[q.id]).map(q => `- ${q.text} ${v.answers[q.id]}`)
  if (v.extra.trim()) lines.push(`- Also: ${v.extra.trim()}`)
  return `Request:\n${v.original}\n\nAnswers:\n${lines.length > 0 ? lines.join('\n') : '- (none given)'}`
}

/** The reply without a fence or quotes around the whole of it. */
export function cleanReply(text: string): string {
  let t = text.trim()
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t)
  if (fenced?.[1] !== undefined) t = fenced[1].trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”')))) t = t.slice(1, -1).trim()
  return t
}

const reasonOf = (r: Exclude<ModelCompleteResult, { isAnswered: true }>) =>
  r.reason === 'api-error' ? `the API answered with an error${r.status ? ` (${r.status})` : ''}` : r.reason === 'empty-reply' ? 'the model replied with nothing' : 'it was cancelled'

/** The person's last prompt in this session, skipping tool results and slash commands. */
async function lastPrompt($: EngineInterface): Promise<string> {
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const t = m?.text.trim() ?? ''
    if (m?.role === 'user' && t && !(m.toolResults?.length ?? 0) && !t.startsWith('/') && !t.includes('<command-')) return t
  }
  return ''
}

// the userConfig model, set as the module registers
let model = 'sonnet'
// each start bumps it, and so does closing: a reply for an older run is dropped
let run = 0

function complete($: EngineInterface, prompt: string, system: string, maxTokens: number): Promise<ModelCompleteResult> {
  return $.model
    .complete({ model, system, prompt, maxTokens })
    .catch((err: unknown) => ({ isAnswered: false, reason: 'api-error', status: null, error: err instanceof Error ? err.message : String(err) }) as never)
}

async function fail($: EngineInterface, mine: number, error: string) {
  if (mine === run) await update($, view, v => (v ? { ...v, phase: 'error' as const, error } : v))
}

async function write($: EngineInterface, mine: number) {
  const v = await read($, view)
  if (!v || mine !== run) return
  await update($, view, () => ({ ...v, phase: 'writing' as const, error: '' }))
  const r = await complete($, writeRequest(v), WRITE, 2000)
  if (mine !== run) return
  if (!r.isAnswered) return fail($, mine, reasonOf(r))
  const upgraded = cleanReply(r.text)
  if (!upgraded) return fail($, mine, 'the model returned an empty prompt')
  await update($, view, x => (x ? { ...x, phase: 'ready' as const, upgraded } : x))
}

async function ask($: EngineInterface, original: string) {
  const mine = ++run
  await update($, view, () => ({ phase: 'asking' as const, original, questions: [], answers: {}, extra: '', upgraded: '', error: '' }))
  await $.ui.open({ id: PANE, title: 'Prompt upgrade', focus: true, closeOnEscape: true })
  const r = await complete($, original, ASK, 1200)
  if (mine !== run) return
  if (!r.isAnswered) return fail($, mine, reasonOf(r))
  const questions = parseQuestions(r.text)
  // already specific, or a reply that didn't parse: straight to the rewrite
  if (questions.length === 0) return write($, mine)
  await update($, view, v => (v ? { ...v, phase: 'answering' as const, questions } : v))
}

async function close($: EngineInterface) {
  run++
  await update($, view, () => null)
  await $.ui.close({ id: PANE })
}

/** A start that failed outside the model call (the pane, the state) shows its reason in the pane. */
async function begin($: EngineInterface, original: string) {
  await ask($, original).catch((err: unknown) => fail($, run, err instanceof Error ? err.message : String(err)))
}

export const register: Register = (on, options) => {
  model = String(options?.model ?? '').trim() || 'sonnet'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'improve',
      description: 'Prompt upgrade: answer a few questions, get a fuller prompt to run, edit or copy (no text: your last prompt)',
      argumentHint: '<your prompt>',
    })
    return next(e)
  })

  on('command.run', { command: 'improve' }, async ($, e) => {
    const typed = String(e.args ?? '').trim()
    const original = typed || (await lastPrompt($))
    if (!original) return { text: 'Usage: /improve <your prompt>. With nothing after it, /improve takes your last prompt.' }
    void begin($, original)
    return { text: `Prompt upgrade: reading ${typed ? 'your prompt' : 'your last prompt'}. Answer its questions in the pane.` }
  }).catch(() => ({ text: 'Prompt upgrade could not start: your last prompt could not be read. Try /improve <your prompt>.' }))

  // the person closed the pane: drop the run and its view
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      run++
      await update($, view, () => null)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    // the mobile app draws no text field: there the questions alone shape the rewrite
    const Input = 'Input' in els ? els.Input : undefined
    const v = await read($, view)
    if (!v) return <Text dimColor>{'Nothing to upgrade. /improve <your prompt> starts one.'}</Text>
    const cols = e.props.bodyColumns ?? 80
    const set = (fn: (x: Upgrade) => Upgrade) => void update($, view, x => (x ? fn(x) : x))
    const typed = (
      <Box flexDirection="column">
        <Text dimColor>You typed</Text>
        <Text>{v.original}</Text>
      </Box>
    )
    const cancel = <Button key="cancel" label="Cancel" onPress={() => void close($)} />

    if (v.phase === 'asking' || v.phase === 'writing')
      return (
        <Box flexDirection="column" rowGap={1}>
          {typed}
          <Text dimColor>{v.phase === 'asking' ? 'Reading your prompt…' : 'Writing your upgraded prompt…'}</Text>
          {cancel}
        </Box>
      )

    if (v.phase === 'error')
      return (
        <Box flexDirection="column" rowGap={1}>
          {typed}
          <Text color="#f87171">Couldn't upgrade it: {v.error}.</Text>
          <Box flexDirection="row" columnGap={1}>
            <Button key="retry" label="Try again" variant="primary" onPress={() => void begin($, v.original)} />
            <Button key="close" label="Close" onPress={() => void close($)} />
          </Box>
        </Box>
      )

    if (v.phase === 'answering')
      return (
        <Box flexDirection="column" rowGap={1}>
          {typed}
          {v.questions.map((q, i) => {
            const picked = v.answers[q.id] ?? ''
            const pick = (value: string) => () => set(x => ({ ...x, answers: { ...x.answers, [q.id]: value } }))
            return (
              <Box key={`row-${q.id}`} flexDirection="column">
                <Text bold>
                  {i + 1}. {q.text}
                </Text>
                <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                  {q.options.map((o, n) => (
                    <Button
                      key={`${q.id}-${n}`}
                      label={picked === o ? `● ${o}` : o}
                      variant={picked === o ? 'primary' : 'secondary'}
                      {...(i === 0 && n === 0 ? { autoFocus: true as const } : {})}
                      onPress={pick(o)}
                    />
                  ))}
                  <Button key={`${q.id}-skip`} label={picked ? 'Skip' : '● Skip'} plain onPress={pick('')} />
                </Box>
              </Box>
            )
          })}
          {Input ? (
            <Input
              key="extra"
              label="Anything else? "
              placeholder="optional"
              value={v.extra}
              onInput={(value: string) => set(x => ({ ...x, extra: value }))}
              onSubmit={(value: string) => set(x => ({ ...x, extra: value }))}
            />
          ) : null}
          <Box flexDirection="row" columnGap={1}>
            <Button key="write" label="Write my prompt" variant="primary" onPress={() => void write($, run)} />
            {cancel}
          </Box>
        </Box>
      )

    const half = Math.max(20, Math.floor((cols - 3) / 2))
    const upgraded = (
      <Box flexDirection="column">
        <Text dimColor>Upgraded</Text>
        <Text>{v.upgraded}</Text>
      </Box>
    )
    return (
      <Box flexDirection="column" rowGap={1}>
        {cols >= SIDE_BY_SIDE ? (
          <Box flexDirection="row" columnGap={3}>
            <Box width={half}>{typed}</Box>
            <Box width={half}>{upgraded}</Box>
          </Box>
        ) : (
          <Box flexDirection="column" rowGap={1}>
            {typed}
            {upgraded}
          </Box>
        )}
        <Box flexDirection="row" columnGap={1}>
          <Button
            key="run"
            label="Run"
            variant="primary"
            onPress={() => {
              const text = v.upgraded
              void close($).then(() => $.prompt.submit({ text }))
            }}
          />
          <Button
            key="edit"
            label="Edit first"
            onPress={() => {
              const text = v.upgraded
              void $.prompt.fill({ text }).then(() => close($))
            }}
          />
          <Button
            key="copy"
            label="Copy"
            onPress={press =>
              void $.ui.copy({ text: v.upgraded, surface: press.surface }).then(r => $.ui.toast(r.isCopied ? 'Upgraded prompt copied.' : `Couldn't copy: ${r.reason}`))
            }
          />
          <Button key="again" label="Start over" onPress={() => void begin($, v.original)} />
          <Button key="close" label="Close" onPress={() => void close($)} />
        </Box>
      </Box>
    )
  })
}
