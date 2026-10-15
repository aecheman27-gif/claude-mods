import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import { ago, branchOf, buildNote, DIR, keepInstructions, LATEST, MAX_AGE_MS, noteName, openTaskCount } from './note'

// At each compaction of the main conversation, a handoff note (goal, open
// tasks, files touched, recent errors) goes to <root>/.claude/handoff/, and the
// summarizer is asked to keep those facts. /handoff writes one on demand. A
// fresh session with a recent note offers to resume from it (fills the prompt,
// never sends). It never compacts on its own. No network, no processes, no
// model calls. Old notes are not pruned: $.fs has no delete.
//
// Only a note this plugin wrote is offered: each write records latest.md's
// SHA-256 and time in $.store, keyed by its path, and a latest.md that doesn't
// match (one committed to a cloned repo, say) is never framed as the person's
// own handoff.

const offer = atom({ plugin: 'checkpoint', key: 'offer' } as const, null)
const RESUME = 'Read .claude/handoff/latest.md and continue from it: re-check the open tasks and files it lists before acting.'

/** What $.store keeps per latest.md this plugin wrote, under `written:<path>`. */
type Written = { sha256: string; savedAt: number }

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function rootOf($: EngineInterface): Promise<string> {
  return (await $.session.root()).replace(/\\/g, '/').replace(/\/+$/, '')
}

async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/** When this plugin wrote `path` with exactly the text it holds now; undefined for any other file. */
async function writtenAt($: EngineInterface, path: string): Promise<number | undefined> {
  const record = (await $.store.get(`written:${path}`)) as Written | undefined
  if (!record || typeof record.sha256 !== 'string' || typeof record.savedAt !== 'number' || !(await $.fs.exists(path))) return undefined
  return (await sha256(String(await $.fs.read(path)))) === record.sha256 ? record.savedAt : undefined
}

async function branch($: EngineInterface, root: string): Promise<string | undefined> {
  try {
    const head = `${root}/.git/HEAD`
    return (await $.fs.exists(head)) ? branchOf(String(await $.fs.read(head))) : undefined
  } catch {
    return undefined
  }
}

/** Writes the note, latest.md and the folder's .gitignore; resolves the note's path relative to the root. */
async function saveNote($: EngineInterface, messages: readonly SessionMessage[], trigger: string): Promise<string> {
  const root = await rootOf($)
  const now = await $.clock.now()
  const note = buildNote(messages, { now, trigger, cwd: await $.session.cwd(), root, branch: await branch($, root) })
  const dir = `${root}/${DIR}`
  const name = noteName(now, trigger)
  if (!(await $.fs.exists(`${dir}/.gitignore`))) await $.fs.write(`${dir}/.gitignore`, '*\n')
  await $.fs.write(`${dir}/${name}`, note)
  await $.fs.write(`${dir}/${LATEST}`, note)
  const written: Written = { sha256: await sha256(note), savedAt: now }
  await $.store.set(`written:${dir}/${LATEST}`, written)
  return `${DIR}/${name}`
}

/** Fills the resume prompt, unless latest.md has changed since the offer and so is no longer this plugin's note. */
async function resumeIfOurs($: EngineInterface) {
  if ((await writtenAt($, `${await rootOf($)}/${DIR}/${LATEST}`)) === undefined) {
    $.ui.toast(`checkpoint: ${DIR}/${LATEST} changed since it was offered, so it was not resumed`)
    return
  }
  await $.prompt.fill({ text: RESUME, mode: 'replace' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'handoff', description: 'Save a checkpoint handoff note now (goal, open tasks, files, recent errors) to .claude/handoff/' }).catch(() => undefined)
    try {
      if ((await $.session.messages()).length === 0) {
        const latest = `${await rootOf($)}/${DIR}/${LATEST}`
        const savedAt = await writtenAt($, latest)
        if (savedAt !== undefined && (await $.clock.now()) - savedAt < MAX_AGE_MS) {
          const tasks = openTaskCount(String(await $.fs.read(latest)))
          await update($, offer, () => ({ savedAt, tasks }))
        }
      }
    } catch {
      // no offer, nothing else lost
    }
    return next(e)
  })

  // Main loop only; a precompute installs nothing and may never be used.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    let instructions = e.instructions
    try {
      const path = await saveNote($, e.messages, e.trigger)
      instructions = keepInstructions(e.instructions, path)
      $.ui.toast(`checkpoint: handoff saved to ${path}`)
    } catch (err) {
      $.ui.toast(`checkpoint: could not save the handoff note (${errText(err)}); compacting anyway`)
    }
    return next(instructions === undefined ? e : { ...e, instructions })
  }).catch(($, e, next) => next(e)) // never block a compaction

  // /handoff, not /checkpoint: Claude Code ships /checkpoint, so that name is refused.
  on('command.run', { command: 'handoff' }, async $ => {
    try {
      const path = await saveNote($, await $.session.messages(), 'checkpoint')
      $.ui.toast(`checkpoint: handoff saved to ${path}`)
      return { text: `Handoff note saved to ${path} (and ${DIR}/${LATEST}).` }
    } catch (err) {
      return { text: `checkpoint: could not save the handoff note (${errText(err)}).` }
    }
  })

  // Once the person sends anything, the session is no longer fresh.
  on('prompt.submit', async ($, e, next) => {
    if (await read($, offer)) await update($, offer, () => null).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const o = await read($, offer)
    if (!o || e.props.hasSurvey) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const when = ago((await $.clock.now()) - o.savedAt)
    const resume = () =>
      void update($, offer, () => null)
        .then(() => resumeIfOurs($))
        .catch(err => $.ui.toast(`checkpoint: could not fill the prompt: ${errText(err)}`))
    const mine = (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Text wrap="truncate-end">
          <Text color="#a78bfa" bold>
            [CKPT]{' '}
          </Text>
          Handoff from {when} ({o.tasks} open task{o.tasks === 1 ? '' : 's'})
        </Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="resume" label="Resume" variant="primary" onPress={resume} />
          <Button key="dismiss" label="Dismiss" onPress={() => void update($, offer, () => null)} />
        </Box>
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
