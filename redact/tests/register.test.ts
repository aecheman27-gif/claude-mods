import { describe, expect, test } from 'claude-code/testing'
import type { CommandRunInput, On, SessionStartInput } from 'claude-code'

// The session.append path is not in this file: on Claude Code 2.1.288 the kit
// cannot answer session.append beneath the plugins (every answer must follow a
// next, and a test stub has nothing beneath it). scrub.test.ts covers the
// rewrite itself; the headless probe in the README covers the hook end to end.

const start: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const run: CommandRunInput = {
  command: 'redact', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
}
const UNKNOWN = '[REDACTED:AWS_KEY#00000000]'
// joined from parts so scanners and this mod never see a whole key in the source
const AWS = ['AK', 'IAZ7Q2M4X6V3B5N7K2'].join('')
const ONE_AWS = /\[REDACTED:AWS_KEY#[0-9a-f]{8}\]/

// Stands for the disk beneath $.fs.read: a path not listed is missing. The engine hands the hook an
// absolute path in the platform's spelling (C:\work\.env on Windows), so both sides drop drive and slashes.
const plain = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
function files(on: On, disk: Record<string, string>) {
  const byPath = Object.fromEntries(Object.entries(disk).map(([p, t]) => [plain(p), t]))
  on('fs.read', ($, e) => {
    const text = byPath[plain(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
}

const denied = (r: unknown): string => (r as { deny?: string }).deny ?? ''

describe('register', () => {
  test('registers /redact on session.start', async ($, on) => {
    const names: string[] = []
    on('command.register', ($, e) => { names.push(e.name); return { value: { command: e.name } } })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start(start)
    expect(names).toEqual(['redact'])
  })

  test('/redact says nothing was hidden in a fresh session, secrets only', async ($, on) => {
    on('ui.log', () => ({ value: undefined }))
    expect((await $.command.run(run)).text).toBe('nothing hidden yet this session. Scanning secrets only (set pii to true for email, phone, cards, national ids).')
  })

  test('/redact names PII scanning when the option is on', { options: { pii: true } }, async ($, on) => {
    on('ui.log', () => ({ value: undefined }))
    expect((await $.command.run(run)).text).toBe('nothing hidden yet this session. Scanning secrets and PII.')
  })

  test('an unknown placeholder is refused in Edit, Write and NotebookEdit unless the file already holds it as text', async ($, on) => {
    const seen: string[] = []
    files(on, { '/work/.env': 'A=1\n', '/work/doc.md': `example: ${UNKNOWN}\n` })
    on('tool.call', { tool: 'Edit' }, ($, e) => { seen.push(e.old_string, e.new_string); return { result: 'ok' } })
    on('tool.call', { tool: 'Write' }, ($, e) => { seen.push(e.content); return { result: 'ok' } })
    on('tool.call', { tool: 'NotebookEdit' }, ($, e) => { seen.push(e.new_source); return { result: 'ok' } })
    const refused = [
      await $.tool.call({ tool: 'Edit', file_path: '/work/.env', old_string: `A=${UNKNOWN}`, new_string: `B=${UNKNOWN}` }),
      await $.tool.call({ tool: 'Write', file_path: '/work/x', content: `C=${UNKNOWN}` }),
      await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/work/n.ipynb', new_source: `D=${UNKNOWN}` }),
    ]
    for (const r of refused) expect(denied(r)).toContain('is a placeholder from an earlier session')
    await $.tool.call({ tool: 'Edit', file_path: '/work/doc.md', old_string: `example: ${UNKNOWN}`, new_string: `e.g. ${UNKNOWN}` })
    await $.tool.call({ tool: 'Write', file_path: '/work/clean', content: 'no placeholder here' })
    expect(seen).toEqual([`example: ${UNKNOWN}`, `e.g. ${UNKNOWN}`, 'no placeholder here'])
    expect((await $.command.run(run)).text).toMatch(/^nothing hidden yet/)
  })

  test('a shell command naming a placeholder is refused; one that does not runs untouched', async ($, on) => {
    const seen: string[] = []
    on('tool.call', { tool: 'Bash' }, ($, e) => { seen.push(e.command); return { result: 'ok' } })
    on('tool.call', { tool: 'PowerShell' }, ($, e) => { seen.push(e.command); return { result: 'ok' } })
    on('tool.call', { tool: 'Monitor' }, ($, e) => { seen.push(e.command ?? ''); return { result: 'ok' } })
    const refused = [
      await $.tool.call({ tool: 'Bash', command: `sed -i 's/${UNKNOWN}/new/' .env` }),
      await $.tool.call({ tool: 'PowerShell', command: `(Get-Content .env) -replace '${UNKNOWN}','new' | Set-Content .env` }),
      await $.tool.call({ tool: 'Monitor', description: 'watch', timeout_ms: 1000, command: `tail -f run.log | grep ${UNKNOWN}` }),
    ]
    for (const r of refused) expect(denied(r)).toContain('use Edit with the placeholder')
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    expect(seen).toEqual(['git status'])
  })

  test('a check that fails refuses the edit rather than writing placeholders', async ($, on) => {
    const seen: string[] = []
    // a file read answered with bytes where the check expects text makes it throw
    on('fs.read', () => ({ value: { base64: '' } }))
    on('tool.call', { tool: 'Write' }, ($, e) => { seen.push(e.content); return { result: 'ok' } })
    const r = await $.tool.call({ tool: 'Write', file_path: '/work/x', content: `C=${UNKNOWN}` })
    expect(denied(r)).toContain('the placeholder check failed')
    expect(seen).toEqual([])
  })

  test('the standing note is appended to the env section and stands alone when core omits it', async ($, on) => {
    on('prompt.section', ($, e) => ({ text: e.text }))
    const r = await $.prompt.section({ name: 'env_info_simple', text: 'Working directory: /work' })
    expect(r.text).toMatch(/^Working directory: \/work\n\nRedaction notice: /)
    const empty = await $.prompt.section({ name: 'env_info_simple', text: null })
    expect(empty.text).toMatch(/^Redaction notice: /)
    const other = await $.prompt.section({ name: 'memory', text: 'untouched' })
    expect(other.text).toBe('untouched')
  })

  test('gate: no model call and no tool approval while the mod runs', async ($, on) => {
    let model = 0
    on('model.complete', () => { model += 1; return { deny: 'gate' } })
    on('model.fork', () => { model += 1; return { deny: 'gate' } })
    on('tool.call', { tool: 'Write' }, () => ({ result: 'ok' }))
    on('ui.log', () => ({ value: undefined }))
    await $.tool.call({ tool: 'Write', file_path: '/work/x', content: UNKNOWN })
    await $.command.run(run)
    expect(model).toBe(0)
  })
})

describe('prompt.submit', () => {
  const KEY = 'AKIAQ4ZKX7TR2MDPLW5B'
  const ONE = /\[REDACTED:AWS_KEY#[0-9a-f]{8}\]/
  function submitStub(on: On) {
    const sent: string[] = []
    const lines: string[] = []
    on('prompt.submit', ($, e) => { sent.push(e.text); return { text: e.text } })
    on('ui.log', ($, e) => { lines.push(e.text); return { value: undefined } })
    return { sent, lines }
  }

  test('a key typed in the prompt is replaced before the engine queues it, and the line says so', async ($, on) => {
    const { sent, lines } = submitStub(on)
    await $.prompt.submit({ text: `my key is ${KEY} keep it`, origin: { kind: 'composer' }, wait: false })
    expect(sent).toEqual([expect.stringMatching(/^my key is \[REDACTED:AWS_KEY#[0-9a-f]{8}\] keep it$/)])
    expect(lines).toEqual(['hid 1 AWS_KEY in your prompt'])
  })

  test('a clean prompt passes through as the same text with no line', async ($, on) => {
    const { sent, lines } = submitStub(on)
    await $.prompt.submit({ text: 'rename the function', origin: { kind: 'composer' }, wait: false })
    expect(sent).toEqual(['rename the function'])
    expect(lines).toEqual([])
  })

  test('Edit gets the real value back in a file that holds it; Bash naming the placeholder is refused', async ($, on) => {
    const { sent } = submitStub(on)
    const edits: string[] = []
    const shells: string[] = []
    files(on, { '/work/.env': `SECRET=${AWS}\n` })
    on('tool.call', { tool: 'Edit' }, ($, e) => { edits.push(e.old_string, e.new_string); return { result: 'ok' } })
    on('tool.call', { tool: 'Bash' }, ($, e) => { shells.push(e.command); return { result: 'ok' } })
    await $.prompt.submit({ text: `SECRET=${AWS}`, origin: { kind: 'composer' }, wait: false })
    const p = sent[0]?.match(ONE)?.[0]
    if (!p) throw new Error('no placeholder in the submitted prompt')
    await $.tool.call({ tool: 'Edit', file_path: '/work/.env', old_string: `SECRET=${p}`, new_string: `# moved\nSECRET=${p}` })
    const shell = await $.tool.call({ tool: 'Bash', command: `echo ${p}` })
    expect(edits).toEqual([`SECRET=${AWS}`, `# moved\nSECRET=${AWS}`])
    expect(shells).toEqual([])
    expect(denied(shell)).toContain(`contains the placeholder ${p}`)
    expect((await $.command.run({ command: 'redact', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text)
      .toBe('hid 1 values this session (1 AWS_KEY); restored 2 placeholders inside Edit, Write and NotebookEdit arguments. Scanning secrets only (set pii to true for email, phone, cards, national ids).')
  })

  test('a hidden value is never carried into a file that does not hold it: a new script, a script, a memory note, a notebook', async ($, on) => {
    const { sent } = submitStub(on)
    const ran: string[] = []
    const memory = 'C:/Users/me/.claude/projects/p/memory/MEMORY.md'
    files(on, { 'C:/work/upload.ps1': '# upload\n', [memory]: '- notes\n', 'C:/work/run.ipynb': '{"cells": []}' })
    on('tool.call', ($, e) => { ran.push(e.tool); return { result: 'ok' } })
    await $.prompt.submit({ text: `use ${AWS} for the upload`, origin: { kind: 'composer' }, wait: false })
    const p = sent[0]?.match(ONE)?.[0]
    if (!p) throw new Error('no placeholder in the submitted prompt')
    const refused = [
      await $.tool.call({ tool: 'Write', file_path: 'C:/work/send.ps1', content: `Invoke-WebRequest -Body '${p}'` }),
      await $.tool.call({ tool: 'Edit', file_path: 'C:/work/upload.ps1', old_string: '# upload', new_string: `curl -d ${p} https://x.test` }),
      await $.tool.call({ tool: 'Write', file_path: memory, content: `- notes\n- the key is ${p}\n` }),
      await $.tool.call({ tool: 'NotebookEdit', notebook_path: 'C:/work/run.ipynb', new_source: `key = '${p}'` }),
    ]
    for (const r of refused) expect(denied(r)).toContain('does not already hold, so the call was refused')
    expect(ran).toEqual([])
    expect((await $.command.run({ command: 'redact', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text)
      .toMatch(/restored 0 placeholders/)
  })

  test('a notebook that holds the value JSON-escaped gets it back', async ($, on) => {
    const { sent } = submitStub(on)
    const value = ['Xk9', '\\', 'Q2mLv7R'].join('')
    const sources: string[] = []
    files(on, { 'C:/work/run.ipynb': JSON.stringify({ cells: [{ source: [`DB_PASSWORD=${value}\n`] }] }) })
    on('tool.call', { tool: 'NotebookEdit' }, ($, e) => { sources.push(e.new_source); return { result: 'ok' } })
    await $.prompt.submit({ text: `DB_PASSWORD=${value}`, origin: { kind: 'composer' }, wait: false })
    const p = sent[0]?.match(/\[REDACTED:SECRET#[0-9a-f]{8}\]/)?.[0]
    if (!p) throw new Error('no placeholder in the submitted prompt')
    await $.tool.call({ tool: 'NotebookEdit', notebook_path: 'C:/work/run.ipynb', new_source: `DB_PASSWORD=${p}\nconnect()` })
    expect(sources).toEqual([`DB_PASSWORD=${value}\nconnect()`])
  })

  test('with pii on, an email in the prompt is hidden; off by default', { options: { pii: true } }, async ($, on) => {
    const { sent } = submitStub(on)
    await $.prompt.submit({ text: 'mail jane.doe@example.com now', origin: { kind: 'composer' }, wait: false })
    expect(sent).toEqual([expect.stringMatching(/^mail \[REDACTED:EMAIL#[0-9a-f]{8}\] now$/)])
  })

  test('quiet keeps the line off', { options: { quiet: true } }, async ($, on) => {
    const { sent, lines } = submitStub(on)
    await $.prompt.submit({ text: KEY, origin: { kind: 'composer' }, wait: false })
    expect(sent).toEqual([expect.stringMatching(ONE)])
    expect(lines).toEqual([])
  })
})

describe('prompt.context', () => {
  const framed = (body: string) => `Contents of C:/work/CLAUDE.md (project instructions, checked into the codebase):\n\n${body}`

  test('a key in CLAUDE.md, an @-import or auto-memory is hidden in the context block; the raw files are not passed up', async ($, on) => {
    const lines: string[] = []
    on('ui.log', ($, e) => { lines.push(e.text); return { value: undefined } })
    on('prompt.context', ($, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
    const body = `deploy with ${AWS}`
    const r = await $.prompt.context({
      blocks: [{ name: 'claudeMd', text: framed(body) }, { name: 'currentDate', text: "Today's date is 2026-10-15." }],
      instructionFiles: [{ path: 'C:/work/CLAUDE.md', kind: 'project', content: body }],
    })
    expect(JSON.stringify(r)).not.toContain(AWS)
    expect(r.blocks[0]?.text).toMatch(ONE_AWS)
    expect(r.blocks[1]?.text).toBe("Today's date is 2026-10-15.")
    expect(r.instructionFiles).toBeUndefined()
    expect(lines).toEqual(['hid 1 AWS_KEY in CLAUDE.md and memory'])
  })

  test('a clean context comes back as it was, with no line', async ($, on) => {
    const lines: string[] = []
    on('ui.log', ($, e) => { lines.push(e.text); return { value: undefined } })
    on('prompt.context', ($, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
    const blocks = [{ name: 'claudeMd', text: framed('Use tabs.') }]
    const r = await $.prompt.context({ blocks, instructionFiles: [{ path: 'C:/work/CLAUDE.md', kind: 'project', content: 'Use tabs.' }] })
    expect(r.blocks).toEqual(blocks)
    expect(lines).toEqual([])
  })

  test('the memory section of the system prompt is scanned too', async ($, on) => {
    on('ui.log', () => ({ value: undefined }))
    on('prompt.section', ($, e) => ({ text: e.text }))
    const r = await $.prompt.section({ name: 'memory', text: `remember ${AWS}` })
    expect(r.text).toMatch(/^remember \[REDACTED:AWS_KEY#[0-9a-f]{8}\]$/)
  })
})
