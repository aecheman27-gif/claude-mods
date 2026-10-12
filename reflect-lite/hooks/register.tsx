import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pending } from '../types'
import { ruleFrom, SKILL_HEADER, withRule } from './rules'

// When a typed prompt reads like a correction, a band offers to keep it as a
// rule: in ~/.claude/CLAUDE.md, the project's CLAUDE.md, or a learned-rules
// skill. Matching is local (no model calls); a save adds one line and keeps
// the rest of the file as it was. No network, no processes.

const pending = atom({ plugin: 'reflect-lite', key: 'pending' } as const, [])
const HUMAN = new Set(['composer', 'bridge'])
const MAX_PENDING = 5

type Target = 'global' | 'project' | 'skill'

async function home($: EngineInterface): Promise<string> {
  const h = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  if (!h) throw new Error('no home directory')
  return h.replace(/\\/g, '/').replace(/\/+$/, '')
}

async function pathFor($: EngineInterface, target: Target): Promise<string> {
  if (target === 'project') return `${(await $.session.root()).replace(/\\/g, '/').replace(/\/+$/, '')}/CLAUDE.md`
  if (target === 'skill') return `${await home($)}/.claude/skills/learned-rules/SKILL.md`
  return `${await home($)}/.claude/CLAUDE.md`
}

async function save($: EngineInterface, p: Pending, target: Target) {
  const path = await pathFor($, target)
  const before = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
  const after = withRule(before, p.rule, target === 'skill' ? SKILL_HEADER : '')
  if (after === undefined) $.ui.toast(`reflect-lite: already in ${path}`)
  else {
    await $.fs.write(path, after)
    $.ui.toast(`reflect-lite: saved to ${path}`)
  }
  await update($, pending, list => list.filter(x => x.id !== p.id))
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    const rule = HUMAN.has(e.origin.kind) ? ruleFrom(e.text) : undefined
    if (rule !== undefined) {
      await update($, pending, list =>
        list.some(x => x.rule === rule) ? list : [...list, { id: Math.max(0, ...list.map(x => x.id)) + 1, rule, isEditing: false }].slice(-MAX_PENDING),
      ).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // never hold up a prompt

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const list = await read($, pending)
    if (e.props.hasSurvey || list.length === 0) return below
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const p = list[0]
    const fail = (err: unknown) => $.ui.toast(`reflect-lite: could not save: ${err instanceof Error ? err.message : String(err)}`)
    const press = (target: Target) => () => void save($, p, target).catch(fail)
    const edited = (value: string) => {
      const rule = value.replace(/\s+/g, ' ').trim()
      void update($, pending, all => all.map(x => (x.id === p.id ? { ...x, rule: rule || x.rule, isEditing: false } : x)))
    }
    const mine = (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Box flexDirection="row">
          <Text color="#FFB000" bold>
            [LEARN]{' '}
          </Text>
          <Text wrap="truncate-end">
            Save as a rule? <Text color="white">"{p.rule}"</Text>
            {list.length > 1 ? <Text color="gray"> (+{list.length - 1} more)</Text> : ''}
          </Text>
        </Box>
        {p.isEditing && Input ? (
          <Input key={`edit-${p.id}`} label="Rule" value={p.rule} submitLabel="Done" autoFocus onSubmit={edited} />
        ) : (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key="global" label="Global CLAUDE.md" variant="primary" onPress={press('global')} />
            <Button key="project" label="Project CLAUDE.md" onPress={press('project')} />
            <Button key="skill" label="Skill" onPress={press('skill')} />
            {Input ? <Button key="edit" label="Edit" onPress={() => void update($, pending, all => all.map(x => (x.id === p.id ? { ...x, isEditing: true } : x)))} /> : ''}
            <Button key="skip" label="Skip" onPress={() => void update($, pending, all => all.filter(x => x.id !== p.id))} />
          </Box>
        )}
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
