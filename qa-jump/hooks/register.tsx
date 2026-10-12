import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry } from '../types'

// A /qa pane listing every question you typed this session, newest first, with
// the start of Claude's answer under it. A click scrolls the transcript to the
// answer (or back to the question). It learns the rows as the main conversation
// stores them (each row's id is the one its transcript row is drawn under) and
// changes nothing. No network, no processes, no model calls.

const PANE = 'qa'
const HUMAN = new Set(['composer', 'bridge'])
const KEEP = 300
const SHOW = 40

const entries = atom({ plugin: 'qa-jump', key: 'entries' } as const, [])

const oneLine = (text: string, max: number) => {
  const t = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? t.slice(0, Math.max(1, max - 1)) + '…' : t
}

/** The transcript row a press scrolls to: the answer where it lands (else where it starts), or the question. */
export const targetOf = (x: Entry, to: 'answer' | 'ask'): string | undefined => (to === 'ask' ? x.id : (x.answerId ?? x.firstAnswerId))

async function jump($: EngineInterface, id: string | undefined) {
  if (!id) return
  const why = await $.ui
    .scroll({ to: { requestId: id }, block: 'start' })
    .then(r => r.deny)
    .catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
  if (why) $.ui.toast(`qa-jump: couldn't scroll there (${why})`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'qa', description: 'Show or hide the questions pane: click one to jump to its answer' })
    return next(e)
  })

  on('command.run', { command: 'qa' }, async $ => {
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: 'Questions pane closed.' }
    }
    await $.ui.open({ id: PANE, title: 'Questions' })
    return { text: 'Questions pane opened.' }
  })

  // A prompt you typed starts an entry; the response rows after it are its
  // answer: the first one opens it, the last one with text is where it lands.
  // A prompt nobody typed (a task notification, a plugin, another agent) closes
  // it: what answers that prompt isn't the answer to yours.
  on('session.append', { door: ['prompt', 'response'] }, async ($, e, next) => {
    const kept = await next(e)
    if (e.agentId) return kept
    const text = e.message.content
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trim()
    if (e.door === 'prompt') {
      if (!HUMAN.has(e.origin.kind)) {
        await update($, entries, list => {
          const last = list.at(-1)
          return !last || last.isClosed ? list : [...list.slice(0, -1), { ...last, isClosed: true }]
        })
        return kept
      }
      if (e.message.isMeta || !text || text.startsWith('/')) return kept
      await update($, entries, list => [...list, { n: (list.at(-1)?.n ?? 0) + 1, id: e.uuid, question: oneLine(text, 200) }].slice(-KEEP))
    } else {
      await update($, entries, list => {
        const last = list.at(-1)
        if (!last || last.isClosed) return list
        const now: Entry = { ...last, firstAnswerId: last.firstAnswerId ?? e.uuid }
        if (text) {
          now.answerId = e.uuid
          now.preview = oneLine(text, 160)
        }
        return [...list.slice(0, -1), now]
      })
    }
    return kept
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = (await read($, entries)).slice(-SHOW).reverse()
    const width = e.props.bodyColumns
    return (
      <Box flexDirection="column" width={width}>
        {list.length === 0 && <Text dimColor>Questions you type show here; click one to jump to its answer.</Text>}
        {list.map(x => (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              <Text color="#38bdf8">{String(x.n).padStart(3)}</Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">{x.question}</Text>
              </Box>
              {targetOf(x, 'answer') ? <Button key={`a-${x.n}`} label="answer" variant="primary" onPress={() => void jump($, targetOf(x, 'answer'))} /> : null}
              <Button key={`q-${x.n}`} label="ask" onPress={() => void jump($, targetOf(x, 'ask'))} />
            </Box>
            <Text dimColor wrap="truncate-end">
              {'    ↳ '}
              {x.preview ?? (x.firstAnswerId ? 'working…' : 'no answer yet')}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
