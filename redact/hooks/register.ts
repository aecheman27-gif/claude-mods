import type { EngineInterface, PluginOptions, PromptContextResult, Register, SessionAppendInput } from 'claude-code'
import { atom, read, update } from 'claude-code'
import { WITHHELD, describe, fnv1a, redactBlocks, redactText, refused, restore, shaped, tally, withhold, type Refusal, type Settings } from './scrub'

const vault = atom({ plugin: 'redact', key: 'vault' } as const, {} as Record<string, string>)
const salt = atom({ plugin: 'redact', key: 'salt' } as const, '')
const counts = atom({ plugin: 'redact', key: 'counts' } as const, {} as Record<string, number>)
const restored = atom({ plugin: 'redact', key: 'restored' } as const, 0)

const NOTE = [
  'Redaction notice: strings shaped like [REDACTED:LABEL#hex] are placeholders a local redactor inserted',
  'in place of secrets and personal data before you saw them. The real value is restored only when a',
  'placeholder is passed verbatim in Edit, Write or NotebookEdit arguments for a file that already holds',
  'that value; a call that would carry it into any other file, or that uses a placeholder from an earlier',
  'session, is refused. Never ask the person for the hidden value, never try to reconstruct it, and never',
  'put a placeholder in a shell command (such calls are refused): change a line that holds one with Edit.',
].join(' ')

const RESTORE_FAILED = 'redact: the placeholder check failed, so this call was blocked rather than run with placeholders or a hidden value.'

function refusal(r: Refusal, path: string): string {
  if (r.isKnown) {
    return `redact: ${r.placeholder} stands for a hidden value that ${path} does not already hold, so the call was refused. A hidden value is put back only into a file that already contains it (an edit that keeps an existing secret), never carried into a new file, script or note. Leave that value out, or ask the person to add it themselves.`
  }
  return `redact: ${r.placeholder} is a placeholder from an earlier session (redact forgets its values on /clear, /resume and restart), or one it never made, so it would land in ${path} as literal text. Re-read the source file to get a current placeholder, then retry.`
}

// The context blocks with every text scanned. A rewritten claudeMd text leaves the files behind it unknown
// from here up (the engine drops the list), which is the price of sending only text this hook has scanned:
// a changed list instead would have the engine render the text again, out of this hook's sight.
async function scrubContext($: EngineInterface, r: PromptContextResult, cfg: Settings): Promise<PromptContextResult> {
  const s = await ensureSalt($)
  const blocks = r.blocks.map(b => ({ b, red: redactText(b.text, s, cfg) }))
  const hits = blocks.flatMap(x => x.red.hits)
  if (hits.length === 0) return r
  await remember($, blocks.flatMap(x => x.red.pairs), tally(hits), cfg, 'CLAUDE.md and memory')
  return { blocks: blocks.map(x => (x.red.hits.length ? { ...x.b, text: x.red.text } : x.b)) }
}

const DOORS: Record<string, string> = {
  'prompt': 'your prompt',
  'command': 'a command result',
  'response': "Claude's reply",
  'tool-result': 'a tool result',
  'tool-message': 'a tool message',
  'delivery': 'a delivered message',
  'attachment': 'an attachment',
  'hook-context': 'hook context',
  'note': 'a plugin note',
  'compaction': 'the compaction summary',
  'notice': 'a notice',
}

function settings(options: PluginOptions): Settings {
  const off = typeof options.off === 'string' ? options.off.split(',').map(s => s.trim()).filter(Boolean) : []
  return { pii: options.pii === true, quiet: options.quiet === true, off: new Set(off) }
}

async function ensureSalt($: EngineInterface): Promise<string> {
  const have = await read($, salt)
  if (have) return have
  const fresh = fnv1a(String(Math.random()) + String(Date.now())) + fnv1a(String(Math.random()) + String(performance.now()))
  await update($, salt, () => fresh)
  return fresh
}

async function remember($: EngineInterface, pairs: ReadonlyArray<readonly [string, string]>, found: Record<string, number>, cfg: Settings, place: string): Promise<void> {
  await update($, vault, v => ({ ...v, ...Object.fromEntries(pairs) }))
  await update($, counts, c => {
    const total: Record<string, number> = { ...c }
    for (const [label, n] of Object.entries(found)) total[label] = (total[label] ?? 0) + n
    return total
  })
  if (!cfg.quiet) $.ui.log(`hid ${describe(found)} in ${place}`)
}

function where(e: SessionAppendInput): string {
  const agent = e.agentId ? ' (subagent)' : ''
  return (DOORS[e.door] ?? e.door) + agent
}

export const register: Register = (on, options) => {
  const cfg = settings(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'redact', description: 'Show what redact hid in this session' })
    return started
  })

  // The typed prompt is scrubbed before the turn starts, so the on-screen echo
  // and the command args hold the placeholder. The engine's queue record is
  // written earlier in the headless path and is out of reach (see README).
  on('prompt.submit', async ($, e, next) => {
    const s = await ensureSalt($)
    const r = redactText(e.text, s, cfg)
    if (r.hits.length === 0) return next(e)
    await remember($, r.pairs, tally(r.hits), cfg, 'your prompt')
    return next({ ...e, text: r.text })
  })

  on('session.append', async ($, e, next) => {
    const s = await ensureSalt($)
    const r = redactBlocks(e.message.content, s, cfg)
    if (r.hits.length === 0) return next(e)
    await remember($, r.pairs, tally(r.hits), cfg, where(e))
    return next({ ...e, message: { ...e.message, content: r.blocks } })
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    $.ui.log(`scanning failed, so this row was withheld from the model (${where(e)})`)
    return next({ ...e, message: { ...e.message, content: withhold(e.message.content) } })
  })

  // CLAUDE.md, its @-imports and auto-memory ride the first user message as context blocks, never as a
  // stored row, so session.append never sees them: they are scanned here, on the way up.
  on('prompt.context', async ($, e, next) => scrubContext($, await next(e), cfg)).catch(async ($, e, next) => {
    const r = await next(e)
    $.ui.log('scanning failed, so CLAUDE.md and memory were withheld from the model')
    return { blocks: r.blocks.map(b => ({ ...b, text: WITHHELD })) }
  })

  on('prompt.section', { name: 'memory' }, async ($, e, next) => {
    const r = await next(e)
    if (!r.text) return r
    const red = redactText(r.text, await ensureSalt($), cfg)
    if (red.hits.length === 0) return r
    await remember($, red.pairs, tally(red.hits), cfg, 'the memory section')
    return { text: red.text }
  }).catch(async ($, e, next) => {
    await next(e)
    return { text: WITHHELD }
  })

  // A value is put back only into a file that already holds it, so a placeholder never carries a hidden
  // value somewhere new; one the vault does not know is refused rather than written as literal text.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const args = e.tool === 'Edit' ? [e.old_string, e.new_string] : e.tool === 'Write' ? [e.content] : e.tool === 'NotebookEdit' ? [e.new_source] : []
    if (!args.some(a => shaped(a) !== undefined)) return next(e)
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    const v = await read($, vault)
    const file = await $.fs.read(path).catch(() => '') // a new file holds nothing
    const bad = refused(args, v, file)
    if (bad) return { deny: refusal(bad, path) }
    if (e.tool === 'Edit') {
      const o = restore(e.old_string, v)
      const n = restore(e.new_string, v)
      if (o.n + n.n === 0) return next(e)
      await update($, restored, k => k + o.n + n.n)
      return next({ ...e, old_string: o.text, new_string: n.text })
    }
    if (e.tool === 'Write') {
      const c = restore(e.content, v)
      if (c.n === 0) return next(e)
      await update($, restored, k => k + c.n)
      return next({ ...e, content: c.text })
    }
    if (e.tool === 'NotebookEdit') {
      const c = restore(e.new_source, v)
      if (c.n === 0) return next(e)
      await update($, restored, k => k + c.n)
      return next({ ...e, new_source: c.text })
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: RESTORE_FAILED }))

  // A shell never gets the real value, and in -replace, sed or grep the brackets read as a character class
  // that rewrites the wrong text, so a command naming a placeholder is refused, never run.
  on('tool.call', { tool: ['Bash', 'PowerShell', 'Monitor'] }, async ($, e, next) => {
    const p = shaped(String(e.command ?? ''))
    if (p === undefined) return next(e)
    return {
      deny: `redact: this command contains the placeholder ${p}. A shell never gets the hidden value, and in -replace, sed or grep its brackets act as a character class and change the wrong text. To change a line that holds a hidden value, use Edit with the placeholder in old_string and new_string.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: RESTORE_FAILED }))

  on('prompt.section', { name: 'env_info_simple' }, async ($, e, next) => {
    const r = await next(e)
    return { text: r.text ? `${r.text}\n\n${NOTE}` : NOTE }
  })

  on('command.run', { command: 'redact' }, async $ => {
    const c = await read($, counts)
    const k = await read($, restored)
    const total = Object.values(c).reduce((a, b) => a + b, 0)
    const rules = cfg.pii ? 'secrets and PII' : 'secrets only (set pii to true for email, phone, cards, national ids)'
    if (total === 0) return { text: `nothing hidden yet this session. Scanning ${rules}.` }
    return { text: `hid ${total} values this session (${describe(c)}); restored ${k} placeholders inside Edit, Write and NotebookEdit arguments. Scanning ${rules}.` }
  })
}
