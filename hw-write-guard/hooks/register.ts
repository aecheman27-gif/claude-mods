import type { EngineInterface, Register } from 'claude-code'

import { catted, cdTarget, DYN, isPythonFile, mosquittoTopic, parseShell, piped, pythonHits, pythonRun, writeHits } from './detect'

// Asks before a tool call that would drive hardware. Every way the question can
// fail to get a "Run it" (Cancel, Other text, closed, nobody to ask, an error in
// this module) denies the call. /hw-guard notify or off drops the question (see
// Mode below). Reads files with $.fs only: no network, no processes, no model calls.

const ASK_OPTIONS = { options: ['Cancel', 'Run it'], header: 'HW write' } as const
const stats = { asked: 0, ran: 0, denied: 0 }

const isAbsolute = (p: string) => /^([A-Za-z]:[\\/]|[\\/])/.test(p)
/** `p` from `dir`, with / separators and . and .. folded. */
const join = (dir: string, p: string) => {
  const out: string[] = []
  for (const part of (isAbsolute(p) ? p : `${dir}/${p}`).split(/[\\/]+/)) {
    if (part === '.' || (part === '' && out.length)) continue
    if (part === '..' && out.length > 1) out.pop()
    else out.push(part)
  }
  return out.join('/')
}
const short = (p: string) => p.replace(/^.*[\\/]/, '').split(DYN).join('')
const MAX_DIRS = 16

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * The hardware writes a shell command would run, and the Python it runs that
 * could not be read (missing file, python -m, stdin from elsewhere, $VARs).
 */
async function shellHits($: EngineInterface, command: string, ps: boolean): Promise<{ found: string[]; unseen: string[] }> {
  const { segments, heredocs, opaque } = parseShell(command, ps)
  // Every directory a relative path may be relative to: the session's, then
  // each cd/pushd/Set-Location target seen so far. Kept, not replaced, so a cd
  // in a subshell or a branch that never ran can't hide the real directory.
  let dirs = [await $.session.cwd()]
  let lost = false // a cd went somewhere that can't be named: relative paths can't be read
  const written = new Map(heredocs.filter(h => h.target).map(h => [h.target as string, h.body]))
  const found = new Set<string>()
  const unseen = new Set(opaque)
  /** Every text the paths may name; empty when none can be read. */
  const readAll = async (...paths: string[]) => {
    const texts: string[] = []
    for (const p of paths) {
      const doc = written.get(p)
      if (doc !== undefined) texts.push(doc)
      else if (p.includes(DYN) || (lost && !isAbsolute(p))) continue
      else {
        for (const dir of isAbsolute(p) ? [''] : dirs) {
          const text = await readText($, join(dir, p))
          if (text !== undefined) texts.push(text)
        }
      }
    }
    return texts
  }
  for (const pipeline of segments) {
    for (let s = 0; s < pipeline.length; s++) {
      const { words, index } = pipeline[s]
      const to = cdTarget(words)
      if (to === null) lost = true
      else if (to !== undefined) {
        dirs = [...new Set([...dirs, ...dirs.map(d => join(d, to))])]
        if (dirs.length > MAX_DIRS) lost = true
      }
      const topic = mosquittoTopic(words)
      if (topic) found.add(`mosquitto_pub to ${topic}`)
      const run = pythonRun(words)
      if (!run) continue
      if (run.kind === 'opaque') {
        unseen.add(run.what)
        continue
      }
      let codes: string[]
      let where: string
      if (run.kind === 'code') {
        codes = [run.code]
        where = run.label
      } else if (run.kind === 'script') {
        codes = await readAll(run.path)
        where = short(run.path)
      } else if (run.kind === 'module') {
        const rel = run.module.replace(/\./g, '/')
        codes = await readAll(`${rel}.py`, `${rel}/__main__.py`)
        where = `python -m ${run.module.split(DYN).join('')}`
      } else {
        const prev = s > 0 ? pipeline[s - 1] : undefined
        const doc = heredocs.find(h => !h.target && (h.segment === index || h.segment === prev?.index))
        const file = run.file ?? (prev && catted(prev.words))
        if (!prev && !doc && file === undefined) continue // nothing feeds stdin
        const text = doc?.body ?? (prev && piped(prev.words))
        codes = text !== undefined ? [text] : file !== undefined ? await readAll(file) : []
        where = file !== undefined && text === undefined ? short(file) : 'python stdin'
      }
      if (!codes.length || codes.some(c => c.includes(DYN))) {
        unseen.add(where)
        continue
      }
      for (const code of codes) for (const hit of pythonHits(code)) found.add(`${hit} (${where})`)
    }
  }
  return { found: [...found], unseen: [...unseen] }
}

async function fileHits($: EngineInterface, path: string, apply: (before: string) => string, changed: string): Promise<string | undefined> {
  const before = (await readText($, path)) ?? ''
  const hits = writeHits(before, apply(before), changed)
  return hits.length ? `${hits.join('; ')} in ${short(path)}` : undefined
}

function notebookCode(json: string): string {
  try {
    const nb = JSON.parse(json) as { cells?: { cell_type?: string; source?: string | string[] }[] }
    return (nb.cells ?? [])
      .filter(c => c.cell_type === 'code')
      .map(c => (Array.isArray(c.source) ? c.source.join('') : (c.source ?? '')))
      .join('\n')
  } catch {
    return ''
  }
}

async function ask($: EngineInterface, summary: string, title = 'Hardware write'): Promise<string | undefined> {
  stats.asked += 1
  let answer: string
  try {
    answer = await $.ui.ask(`${title}: ${summary}`, ASK_OPTIONS)
  } catch {
    stats.denied += 1
    return 'hw-write-guard: the hardware-write question was closed or nobody could answer it, so the call was blocked.'
  }
  if (answer === 'Run it') {
    stats.ran += 1
    return undefined
  }
  stats.denied += 1
  return `hw-write-guard: the user did not approve this hardware write (${summary}). Do not retry it unless they ask.`
}

const DENY_ON_ERROR = 'hw-write-guard: the hardware-write check failed, so the call was blocked.'

// ask: the question above (the default). notify: no question, a toast names the
// write and it runs. off: no check at all. Kept per machine in $.store; a store
// that can't be read means ask.
type Mode = 'ask' | 'notify' | 'off'
const MODES: readonly Mode[] = ['ask', 'notify', 'off']
const MODE_TEXT: Record<Mode, string> = {
  ask: 'asks before each hardware write',
  notify: 'shows a toast and lets hardware writes run without asking',
  off: 'is off: nothing is checked',
}
async function modeOf($: EngineInterface): Promise<Mode> {
  const m = await $.store.get('mode').catch(() => undefined)
  return MODES.includes(m as Mode) ? (m as Mode) : 'ask'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hw-guard',
      description: 'hw-write-guard status, or /hw-guard ask | notify | off',
      argumentHint: '[ask | notify | off]',
    })
    return next(e)
  })

  on('command.run', { command: 'hw-guard' }, async ($, e) => {
    const word = String(e.args ?? '').trim().toLowerCase()
    if (word) {
      if (!MODES.includes(word as Mode)) return { text: 'Usage: /hw-guard [ask | notify | off]' }
      // Only the user's own typing (here or through Remote Control) changes the mode:
      // never Claude, an agent, a scheduled prompt or another session.
      const kind = (e.origin as { kind?: string } | undefined)?.kind
      if (kind !== 'composer' && kind !== 'bridge') {
        return { text: 'hw-write-guard: only the user can change the mode, by typing /hw-guard at the prompt.' }
      }
      await $.store.set('mode', word)
      return { text: `hw-write-guard now ${MODE_TEXT[word as Mode]}. /hw-guard ask turns the question back on.` }
    }
    return {
      text: `hw-write-guard ${MODE_TEXT[await modeOf($)]} (Bash, PowerShell, Write, Edit, NotebookEdit). This session: asked ${stats.asked}, ran ${stats.ran}, denied ${stats.denied}. Change it with /hw-guard ask | notify | off.`,
    }
  })

  on('tool.call', { tool: ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit'] }, async ($, e, next) => {
    const mode = await modeOf($)
    if (mode === 'off') return next(e)
    let summary: string | undefined
    let title: string | undefined
    if (e.tool === 'Bash' || e.tool === 'PowerShell') {
      // Python that runs but could not be read asks too: never allow what wasn't seen.
      const { found, unseen } = await shellHits($, e.command, e.tool === 'PowerShell')
      const blind = unseen.length ? [`could not inspect ${unseen.join(', ')}`] : []
      if (found.length || blind.length) summary = [...found, ...blind].join('; ')
      if (!found.length && blind.length) title = 'Hardware write check'
    } else if (e.tool === 'Write') {
      if (isPythonFile(e.file_path)) summary = await fileHits($, e.file_path, () => e.content, e.content)
    } else if (e.tool === 'Edit') {
      if (isPythonFile(e.file_path)) {
        summary = await fileHits(
          $,
          e.file_path,
          before => {
            if (e.replace_all) return before.split(e.old_string).join(e.new_string)
            const at = before.indexOf(e.old_string)
            return at === -1 ? before + '\n' + e.new_string : before.slice(0, at) + e.new_string + before.slice(at + e.old_string.length)
          },
          e.new_string,
        )
      }
    } else if (e.tool === 'NotebookEdit') {
      if (e.cell_type !== 'markdown' && e.edit_mode !== 'delete') {
        const before = notebookCode((await readText($, e.notebook_path)) ?? '')
        const hits = writeHits(before, `${before}\n${e.new_source}`, e.new_source)
        if (hits.length) summary = `${hits.join('; ')} in ${short(e.notebook_path)}`
      }
    }
    if (summary === undefined) return next(e)
    const shown = summary.length > 120 ? summary.slice(0, 117) + '...' : summary
    if (mode === 'notify') {
      stats.ran += 1
      try {
        $.ui.toast(`hw-write-guard: running ${shown}`)
      } catch {
        // a toast that can't show never blocks the call
      }
      return next(e)
    }
    const deny = await ask($, shown, title)
    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: DENY_ON_ERROR }))
}
