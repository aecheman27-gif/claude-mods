import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { looksSecret, ruleFrom, withoutImports, withRule } from './rules'

function world(on: On, files: Record<string, string> = {}) {
  const w = { files, toasts: [] as string[], models: 0 }
  const norm = (p: string) => p.replace(/\\/g, '/')
  on('env.get', async ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\r' : undefined }) as never)
  on('session.root', async () => ({ value: 'C:/work/app' }) as never)
  on('fs.exists', async ($, e) => ({ value: norm(e.path) in files }) as never)
  on('fs.read', async ($, e) => ({ value: files[norm(e.path)] }) as never)
  on('fs.write', async ($, e) => {
    files[norm(e.path)] = e.text
    return { value: undefined } as never
  })
  on('ui.toast', async ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined } as never
  })
  on('model.complete', async () => {
    w.models++
    return { value: { isAnswered: false, reason: 'empty-reply', usage: {} } } as never
  })
  on('prompt.submit', async ($, e) => ({ text: e.text }) as never)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['OTHER-MOD-ROW'] }))
  return w
}

const band: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} } as never
const say = ($: Engine, text: string, kind = 'composer') => $.prompt.submit({ text, origin: { kind }, wait: false } as never)
const textOf = async (ui: { findAll: (q: object) => Promise<{ text: string }[]> }) => (await ui.findAll({}))[0]?.text ?? ''

describe('band', () => {
  test('a correction offers a rule, stacked above other rows; no model call', async ($, on) => {
    const w = world(on)
    await say($, "no, don't use npm here, use pnpm")
    const ui = await $.ui.mount({ plugin: 'reflect-lite', surface: 'terminal', component: 'AbovePrompt', props: band })
    const text = await textOf(ui)
    expect(text).toContain(`[LEARN]`)
    expect(text).toContain(`"no, don't use npm here, use pnpm"`)
    expect(text.indexOf('[LEARN]')).toBeLessThan(text.indexOf('OTHER-MOD-ROW'))
    expect(w.models).toBe(0)
  })

  test('an ordinary prompt offers nothing', async ($, on) => {
    world(on)
    await say($, 'add a test for the parser')
    const ui = await $.ui.mount({ plugin: 'reflect-lite', surface: 'terminal', component: 'AbovePrompt', props: band })
    expect(await textOf(ui)).not.toContain('[LEARN]')
  })

  test('a prompt not typed by the person offers nothing', async ($, on) => {
    world(on)
    await say($, 'no, stop that', 'sdk')
    const ui = await $.ui.mount({ plugin: 'reflect-lite', surface: 'terminal', component: 'AbovePrompt', props: band })
    expect(await textOf(ui)).not.toContain('[LEARN]')
  })

  test('Global appends under Learned rules and keeps the file', async ($, on) => {
    const w = world(on, { 'C:/Users/r/.claude/CLAUDE.md': '# Global prefs\r\n\r\n- Be concise.\r\n' })
    await say($, 'remember: run ruff before committing')
    const ui = await $.ui.mount({ plugin: 'reflect-lite', surface: 'terminal', component: 'AbovePrompt', props: band })
    await ui.press({ key: 'global' })
    expect(w.files['C:/Users/r/.claude/CLAUDE.md']).toBe('# Global prefs\r\n\r\n- Be concise.\r\n\r\n## Learned rules\r\n\r\n- run ruff before committing\r\n')
    expect(await textOf(ui)).not.toContain('[LEARN]')
  })

  test('Project writes the project CLAUDE.md; Skill makes the skill file', async ($, on) => {
    const w = world(on)
    await say($, "don't touch the vendored folder")
    await say($, 'I wish you would ask before deleting files')
    const ui = await $.ui.mount({ plugin: 'reflect-lite', surface: 'terminal', component: 'AbovePrompt', props: band })
    expect(await textOf(ui)).toContain('+1 more')
    await ui.press({ key: 'project' })
    expect(w.files['C:/work/app/CLAUDE.md']).toContain("- don't touch the vendored folder")
    await ui.press({ key: 'skill' })
    const skill = w.files['C:/Users/r/.claude/skills/learned-rules/SKILL.md']
    expect(skill).toContain('name: learned-rules')
    expect(skill).toContain('- I wish you would ask before deleting files')
  })

  test('Edit changes the rule before saving; Skip drops it', async ($, on) => {
    const w = world(on)
    await say($, 'never push to main directly please')
    const ui = await $.ui.mount({ plugin: 'reflect-lite', surface: 'terminal', component: 'AbovePrompt', props: band })
    await ui.press({ key: 'edit' })
    await ui.input({ key: 'edit-1', text: 'Never push to main; open a PR.' })
    await ui.press({ key: 'global' })
    expect(w.files['C:/Users/r/.claude/CLAUDE.md']).toContain('- Never push to main; open a PR.')
    await say($, 'stop adding emojis')
    await ui.press({ key: 'skip' })
    expect(await textOf(ui)).not.toContain('[LEARN]')
  })

  test('an @path in a correction is saved inside a code span, never as a CLAUDE.md import', async ($, on) => {
    const w = world(on)
    await say($, 'no, the bug is in @src/daq/driver.py.')
    const ui = await $.ui.mount({ plugin: 'reflect-lite', surface: 'terminal', component: 'AbovePrompt', props: band })
    expect(await textOf(ui)).toContain('"no, the bug is in `@src/daq/driver.py`."')
    await ui.press({ key: 'project' })
    expect(w.files['C:/work/app/CLAUDE.md']).toContain('- no, the bug is in `@src/daq/driver.py`.\n')
    await say($, 'never read the old config')
    await ui.press({ key: 'edit' })
    await ui.input({ key: 'edit-1', text: 'Never load @~/.ssh/config or (@docs/lab.md)' })
    await ui.press({ key: 'global' })
    expect(w.files['C:/Users/r/.claude/CLAUDE.md']).toContain('- Never load `@~/.ssh/config` or (`@docs/lab.md`)\n')
  })

  test('the band shows the whole rule that Save writes, wrapped rather than cut', async ($, on) => {
    world(on)
    const long = `remember: ${'keep the DAQ sample rate at 48 kHz and '.repeat(4)}never change it without asking`
    await say($, long)
    const ui = await $.ui.mount({ plugin: 'reflect-lite', surface: 'terminal', component: 'AbovePrompt', props: { ...band, bodyColumns: 60 } })
    const row = await ui.find({ type: 'Text', text: /^Save as a rule\?/ })
    expect(row?.props.wrap).toBe('wrap')
    expect(row?.text).toContain('never change it without asking')
  })

  test('a duplicate rule is not written twice', async ($, on) => {
    const w = world(on, { 'C:/Users/r/.claude/CLAUDE.md': '## Learned rules\n\n- stop adding emojis\n' })
    await say($, 'stop adding emojis')
    const ui = await $.ui.mount({ plugin: 'reflect-lite', surface: 'terminal', component: 'AbovePrompt', props: band })
    await ui.press({ key: 'global' })
    expect(w.files['C:/Users/r/.claude/CLAUDE.md']).toBe('## Learned rules\n\n- stop adding emojis\n')
    expect(w.toasts[0]).toContain('already')
  })
})

describe('rules', () => {
  test('what counts', async () => {
    expect(ruleFrom('No, use tabs')).toBe('No, use tabs')
    expect(ruleFrom('nothing to add')).toBeUndefined() // "no" must be a word
    expect(ruleFrom('/model opus')).toBeUndefined()
    expect(ruleFrom('no, my key is sk-abcdefghijklmnopqrstuvwx')).toBeUndefined()
    expect(ruleFrom('x'.repeat(400))).toBeUndefined()
  })
  test('a prompt that looks like it carries a secret is never offered', async () => {
    for (const t of [
      'no, use AIzaSyA1234567890abcdefghijklmnopqrstu as the maps key',
      "don't charge with sk_live_51Habcdefghijklmnop",
      'no, password=hunter22 is the lab one',
      'never connect as postgres://daq:s3cretpw@db.lab.local/runs',
      'no, use the key [REDACTED:SECRET#b8b327b0]',
      'no, the bench token is a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8',
    ]) {
      expect({ t, offered: ruleFrom(t) }).toEqual({ t, offered: undefined })
      expect(looksSecret(t)).toBe(true)
    }
    for (const t of ["don't touch the password reset flow", 'no, use https://docs.lab.local/daq', 'never email me at lab@example.com']) {
      expect(ruleFrom(t)).toBeDefined()
    }
  })
  test('@ words go in code spans, once', async () => {
    expect(withoutImports('see @a/b.md, then `@c` and x@y.z')).toBe('see `@a/b.md`, then `@c` and `x@y.z`')
    expect(withoutImports(withoutImports('see @a/b.md'))).toBe('see `@a/b.md`')
    expect(withoutImports('odd `@a`b`')).toBe('odd `@ab`')
  })
  test('inserts at the end of the section, before the next heading', async () => {
    expect(withRule('## Learned rules\n\n- a\n\n## Other\n\ntext\n', 'b')).toBe('## Learned rules\n\n- a\n- b\n\n## Other\n\ntext\n')
  })
})
