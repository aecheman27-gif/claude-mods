import type { EngineInterface, Register } from 'claude-code'

import type { Mode } from '../types'
import {
  catted,
  cdTarget,
  dotnetSerialWrite,
  DYN,
  ipythonShell,
  isNotebook,
  isPsScript,
  isPythonFile,
  isShellScript,
  literalWrite,
  mosquittoTopic,
  parseShell,
  piped,
  type PyImport,
  pyImports,
  pythonBlind,
  pythonHits,
  pythonRun,
  scriptRun,
  scrubPython,
  touches,
  writeHits,
  writtenBy,
} from './detect'

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
const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '')
const short = (p: string) => p.replace(/^.*[\\/]/, '').split(DYN).join('')
/** A path as written, for matching one write against one run: / separators, no leading ./, one case. */
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').toLowerCase()
const MAX_DIRS = 16
const MAX_DEPTH = 3 // scripts that run scripts; modules that import modules
const MAX_MODULES = 40 // local modules read for one Python run

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

/** A file's text; null when it exists but can't be read (over 4 MiB, no access), undefined when there is none. */
async function readOrNull($: EngineInterface, path: string): Promise<string | null | undefined> {
  const text = await readText($, path)
  if (text !== undefined) return text
  return (await $.fs.exists(path).catch(() => true)) ? null : undefined
}

type Scan = { found: string[]; unseen: string[] }
/** What a command writes to a path before running it: the text when literal, null when it can't be told, undefined when nothing does. */
type WrittenTo = (path: string) => string | null | undefined

/** The files `import a.b` or `from a.b import c` may load: a.py, a/__init__.py, a/b.py, ... and a/b/c.py. */
function modulePaths(imp: PyImport, dir: string | undefined, roots: string[]): string[] {
  const dots = /^\.*/.exec(imp.from ?? '')?.[0].length ?? 0
  if (dots && dir === undefined) return []
  let bases = roots
  if (dots) {
    let d = dir as string
    for (let k = 1; k < dots; k++) d = join(d, '..')
    bases = [d]
  }
  const parts = (imp.from === undefined ? imp.name : imp.from.slice(dots)).split('.').filter(Boolean)
  if (imp.from !== undefined && imp.name !== '*') parts.push(imp.name) // c may be a submodule
  const out: string[] = []
  for (const b of bases) {
    for (let k = 1; k <= parts.length; k++) {
      const p = join(b, parts.slice(0, k).join('/'))
      out.push(`${p}.py`, `${p}/__init__.py`)
    }
  }
  return out
}

/**
 * The local modules Python imports, MAX_DEPTH deep and MAX_MODULES at most:
 * each that resolves to a file under `roots` (the script's folder, the working
 * directory) or, for a relative import, its own package. Stdlib and installed
 * packages resolve to no file and are left alone; a local one that can't be
 * read, or that the command changes first, goes in `unseen`.
 */
async function localImports($: EngineInterface, code: string, file: string | undefined, roots: string[], writtenTo: WrittenTo, where: string): Promise<{ files: { path: string; text: string }[]; unseen: string[] }> {
  const files: { path: string; text: string }[] = []
  const unseen: string[] = []
  const tried = new Set<string>()
  const queue = [{ code, dir: file === undefined ? undefined : dirOf(file), depth: 0 }]
  for (let item = queue.shift(); item; item = queue.shift()) {
    if (item.depth >= MAX_DEPTH) continue
    for (const imp of pyImports(scrubPython(item.code).code)) {
      for (const path of modulePaths(imp, item.dir, roots)) {
        if (tried.has(path)) continue
        tried.add(path)
        const doc = writtenTo(path)
        if (doc === null) {
          unseen.push(`${short(path)} (changed earlier in the command)`)
          continue
        }
        // most names are stdlib or installed: one exists() each, a read only for what is there
        if (doc === undefined && !(await $.fs.exists(path).catch(() => true))) continue
        if (doc === undefined && files.length >= MAX_MODULES) {
          unseen.push(`modules ${where} imports past the first ${MAX_MODULES}`)
          return { files, unseen }
        }
        const text = doc ?? (await readText($, path))
        if (text === undefined) unseen.push(`${short(path)} (imported by ${where})`)
        else {
          files.push({ path, text })
          queue.push({ code: text, dir: dirOf(path), depth: item.depth + 1 })
        }
      }
    }
  }
  return { files, unseen }
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

/**
 * Where a shell command runs from (`dirs`, the session's by default), how many
 * scripts deep it is, what the command that ran it wrote first, and the script
 * it is read from.
 */
type ShellContext = { dirs?: string[]; depth?: number; outer?: WrittenTo; label?: string }

/**
 * The hardware writes a shell command would run, and what it runs that could
 * not be read (missing file, python -m, stdin from elsewhere, $VARs, a file the
 * command itself changes first).
 */
async function shellHits($: EngineInterface, command: string, ps: boolean, ctx: ShellContext = {}): Promise<Scan> {
  const { segments, heredocs, opaque } = parseShell(command, ps)
  const depth = ctx.depth ?? 0
  const at = ctx.label ? ` (${ctx.label})` : ''
  // Every directory a relative path may be relative to: the session's, then
  // each cd/pushd/Set-Location target seen so far. Kept, not replaced, so a cd
  // in a subshell or a branch that never ran can't hide the real directory.
  let dirs = ctx.dirs ?? [await $.session.cwd()]
  let lost = false // a cd went somewhere that can't be named: relative paths can't be read
  // What the command writes anywhere in it (order aside, so a write in a $( ) or
  // bash -c counts too): heredoc and literal text it writes, and every other file it may change.
  const writes: { key: string; text?: string }[] = []
  const heredocSegments = new Set<number>()
  for (const h of heredocs) {
    if (h.target === undefined) continue
    writes.push({ key: norm(h.target), text: h.body })
    heredocSegments.add(h.segment)
  }
  for (const pipeline of segments) {
    for (let s = 0; s < pipeline.length; s++) {
      if (heredocSegments.has(pipeline[s]!.index)) continue
      const lit = literalWrite(pipeline, s)
      if (lit) writes.push({ key: norm(lit.path), text: lit.text })
      else for (const p of writtenBy(pipeline[s]!.words)) writes.push({ key: norm(p) })
    }
  }
  const writtenTo: WrittenTo = path => {
    const key = norm(path)
    const hits = writes.filter(w => w.key === key || key.endsWith(`/${w.key}`) || w.key.endsWith(`/${key}`))
    if (!hits.length) return ctx.outer?.(path)
    return hits.length === 1 && hits[0]!.text !== undefined ? hits[0]!.text : null
  }
  const found = new Set<string>()
  const unseen = new Set(opaque)
  const merge = (scan: Scan) => {
    for (const f of scan.found) found.add(f)
    for (const u of scan.unseen) unseen.add(u)
  }
  if (dotnetSerialWrite(command)) found.add(`.NET SerialPort write${at}`)
  /** Every text the paths may name, and whether the command changes one of them first. */
  const readAll = async (...paths: string[]) => {
    const files: { path: string; text: string }[] = []
    let changed = false
    for (const p of paths) {
      const doc = writtenTo(p)
      if (doc === null) changed = true
      else if (doc !== undefined) files.push({ path: join(dirs[dirs.length - 1] ?? '', p), text: doc })
      else if (p.includes(DYN) || (lost && !isAbsolute(p))) continue
      else {
        for (const dir of isAbsolute(p) ? [''] : dirs) {
          const path = join(dir, p)
          const text = await readText($, path)
          if (text !== undefined) files.push({ path, text })
        }
      }
    }
    return { files, changed }
  }
  /** A file of shell commands the command runs, read and parsed in turn. */
  const runScript = async (script: { path: string; ps: boolean }): Promise<Scan> => {
    const name = short(script.path)
    const { files, changed } = await readAll(script.path)
    if (changed) return { found: [], unseen: [`${name} (changed earlier in the command)`] }
    if (!files.length || files.some(f => f.text.includes(DYN))) return { found: [], unseen: [name] }
    if (depth >= MAX_DEPTH) return { found: [], unseen: [`${name} (scripts nested too deep)`] }
    const out: Scan = { found: [], unseen: [] }
    for (const f of files) {
      // the script's own folder, as PowerShell, cmd and sh name it
      const here = dirOf(f.path)
      const text = f.text
        .replace(/\$PSScriptRoot\b/gi, here)
        .replace(/%~dp0/gi, `${here}/`)
        .replace(/\$\(\s*dirname\s+"?\$(0|\{0\}|\{BASH_SOURCE(\[0\])?\})"?\s*\)/g, here)
      const sub = await shellHits($, text, script.ps, { dirs: [...new Set([...dirs, here])], depth: depth + 1, outer: writtenTo, label: name })
      out.found.push(...sub.found)
      out.unseen.push(...sub.unseen)
    }
    return out
  }
  /** The hardware writes in Python sources and the local modules they import; what can't be read goes in `unseen`. */
  const scanPython = async (sources: { path?: string; text: string }[], where: string, roots: string[]) => {
    for (const src of sources) {
      const mods = await localImports($, src.text, src.path, roots, writtenTo, where)
      for (const u of mods.unseen) unseen.add(u)
      const seen = new Set<string>()
      for (const hit of pythonHits(src.text)) {
        seen.add(hit)
        found.add(`${hit} (${where})`)
      }
      for (const m of mods.files) {
        for (const hit of pythonHits(m.text)) {
          seen.add(hit)
          found.add(`${hit} (${short(m.path)} from ${where})`)
        }
      }
      // a write split across files: the task made in a module, written in the script
      if (mods.files.length) {
        for (const hit of pythonHits([src.text, ...mods.files.map(m => m.text)].join('\n'))) if (!seen.has(hit)) found.add(`${hit} (${where} with its imports)`)
      }
      for (const b of pythonBlind(src.text)) unseen.add(`${b} in ${where}`)
      for (const m of mods.files) for (const b of pythonBlind(m.text)) unseen.add(`${b} in ${short(m.path)}`)
      // IPython's !cmd lines and %run, in a notebook or ipython -c
      const shell = ipythonShell(src.text)
      if (shell && depth >= MAX_DEPTH) unseen.add(`${where} (scripts nested too deep)`)
      else if (shell) merge(await shellHits($, shell, false, { dirs, depth: depth + 1, outer: writtenTo }))
    }
  }
  for (const pipeline of segments) {
    for (let s = 0; s < pipeline.length; s++) {
      const { words, index } = pipeline[s]!
      const to = cdTarget(words)
      if (to === null) lost = true
      else if (to !== undefined) {
        dirs = [...new Set([...dirs, ...dirs.map(d => join(d, to))])]
        if (dirs.length > MAX_DIRS) lost = true
      }
      const topic = mosquittoTopic(words)
      if (topic) found.add(`mosquitto_pub to ${topic}${at}`)
      const script = scriptRun(words, ps)
      if (script) {
        merge(await runScript(script))
        continue
      }
      const run = pythonRun(words)
      if (!run) continue
      if (run.kind === 'opaque') {
        unseen.add(run.what)
        continue
      }
      let sources: { path?: string; text: string }[]
      let where: string
      let changed = false
      if (run.kind === 'code') {
        sources = [{ text: run.code }]
        where = run.label
      } else if (run.kind === 'script' || run.kind === 'notebook') {
        const paths = run.kind === 'script' ? [run.path] : run.paths
        ;({ files: sources, changed } = await readAll(...paths))
        if (run.kind === 'notebook') sources = sources.map(f => ({ ...f, text: notebookCode(f.text) }))
        where = paths.map(short).join(', ')
      } else if (run.kind === 'module') {
        const rel = run.module.replace(/\./g, '/')
        ;({ files: sources, changed } = await readAll(`${rel}.py`, `${rel}/__main__.py`))
        where = `python -m ${run.module.split(DYN).join('')}`
      } else {
        const prev = s > 0 ? pipeline[s - 1] : undefined
        const doc = heredocs.find(h => !h.target && (h.segment === index || h.segment === prev?.index))
        const file = run.file ?? (prev && catted(prev.words))
        if (!prev && !doc && file === undefined) continue // nothing feeds stdin
        const text = doc?.body ?? (prev && piped(prev.words))
        if (text !== undefined) sources = [{ text }]
        else if (file !== undefined) ({ files: sources, changed } = await readAll(file))
        else sources = []
        where = file !== undefined && text === undefined ? short(file) : 'python stdin'
      }
      if (changed) {
        unseen.add(`${where} (changed earlier in the command)`)
        continue
      }
      if (!sources.length || sources.some(c => c.text.includes(DYN))) {
        unseen.add(where)
        continue
      }
      // local imports resolve from the script's folder (Python's own rule) and the working directory
      const roots = [...new Set([...sources.flatMap(f => (f.path === undefined ? [] : [dirOf(f.path)])), ...dirs])]
      await scanPython(sources, where, roots)
    }
  }
  return { found: [...found], unseen: [...unseen] }
}

/** The code lines `after` has that `before` lacks. */
const newLines = (before: string, after: string) => {
  const old = new Set(before.split('\n'))
  return after
    .split('\n')
    .filter(l => !old.has(l))
    .join('\n')
}

/**
 * What writing a file puts in place: for Python and notebooks the hardware
 * writes it adds (or touches); for a file of shell commands the hardware writes
 * it would run. `partial`: the new text is an edit of the old, so an old text
 * that can't be read leaves the result unknown.
 */
async function fileHits($: EngineInterface, path: string, apply: (before: string) => string, changed: string, partial: boolean): Promise<Scan> {
  const name = short(path)
  if (!isPythonFile(path) && !isNotebook(path) && !isShellScript(path)) return { found: [], unseen: [] }
  const read = await readOrNull($, path)
  if (read === null && partial && isNotebook(path)) return { found: [], unseen: [name] }
  const before = read ?? ''
  const after = apply(before)
  if (isShellScript(path)) {
    // Running it is checked again then; here only the writes it would run are named.
    const ps = isPsScript(path)
    const ctx = { dirs: [...new Set([await $.session.cwd(), dirOf(path)])], depth: 1 }
    const now = await shellHits($, after, ps, ctx)
    const had = new Set((await shellHits($, before, ps, ctx)).found)
    const isNew = now.found.some(h => !had.has(h)) || (await shellHits($, changed, ps, ctx)).found.length > 0
    return { found: isNew ? now.found.map(h => `${h} in ${name}`) : [], unseen: [] }
  }
  const code = isNotebook(path) ? notebookCode : (text: string) => text
  const was = code(before)
  const is = code(after)
  const hits = writeHits(was, is, isNotebook(path) ? newLines(was, is) : changed)
  const unknown = read === null && partial && !hits.length && touches(changed) ? [name] : []
  const blind = pythonBlind(is).filter(b => !pythonBlind(was).includes(b))
  return { found: hits.length ? [`${hits.join('; ')} in ${name}`] : [], unseen: [...unknown, ...blind.map(b => `${b} in ${name}`)] }
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
// that can't be read means ask. Published in $.state for other mods to show.
const MODES: readonly Mode[] = ['ask', 'notify', 'off']
const MODE_TEXT: Record<Mode, string> = {
  ask: 'asks before each hardware write',
  notify: 'shows a toast and lets hardware writes run without asking',
  off: 'is off: nothing is checked',
}
const MODE = { plugin: 'hw-write-guard', key: 'mode' } as const
async function modeOf($: EngineInterface): Promise<Mode> {
  const m = await $.store.get('mode').catch(() => undefined)
  return MODES.includes(m as Mode) ? (m as Mode) : 'ask'
}
/** Shows the mode to other mods (mission-control's band); a failure here never gets in the guard's way. */
async function publishMode($: EngineInterface, mode: Mode): Promise<void> {
  const held = await $.state.get(MODE).catch(() => undefined)
  if (held?.value !== mode) await $.state.set(MODE, mode).catch(() => undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hw-guard',
      description: 'hw-write-guard status, or /hw-guard ask | notify | off',
      argumentHint: '[ask | notify | off]',
    })
    await publishMode($, await modeOf($))
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
      await publishMode($, word as Mode)
      return { text: `hw-write-guard now ${MODE_TEXT[word as Mode]}. /hw-guard ask turns the question back on.` }
    }
    return {
      text: `hw-write-guard ${MODE_TEXT[await modeOf($)]} (Bash, PowerShell, Monitor, Write, Edit, NotebookEdit). This session: asked ${stats.asked}, ran ${stats.ran}, denied ${stats.denied}. Change it with /hw-guard ask | notify | off.`,
    }
  })

  on('tool.call', { tool: ['Bash', 'PowerShell', 'Monitor', 'Write', 'Edit', 'NotebookEdit'] }, async ($, e, next) => {
    const mode = await modeOf($)
    await publishMode($, mode) // a change made in another session shows here too
    if (mode === 'off') return next(e)
    let scan: Scan = { found: [], unseen: [] }
    if (e.tool === 'Bash' || e.tool === 'PowerShell') {
      // Python that runs but could not be read asks too: never allow what wasn't seen.
      scan = await shellHits($, e.command, e.tool === 'PowerShell')
    } else if (e.tool === 'Monitor') {
      // Monitor does not say which shell runs its command: read it both ways.
      if (e.command !== undefined) {
        const [bashScan, psScan] = [await shellHits($, e.command, false), await shellHits($, e.command, true)]
        scan = { found: [...new Set([...bashScan.found, ...psScan.found])], unseen: [...new Set([...bashScan.unseen, ...psScan.unseen])] }
      }
    } else if (e.tool === 'Write') {
      scan = await fileHits($, e.file_path, () => e.content, e.content, false)
    } else if (e.tool === 'Edit') {
      scan = await fileHits(
        $,
        e.file_path,
        before => {
          if (e.replace_all) return before.split(e.old_string).join(e.new_string)
          const at = before.indexOf(e.old_string)
          return at === -1 ? before + '\n' + e.new_string : before.slice(0, at) + e.new_string + before.slice(at + e.old_string.length)
        },
        e.new_string,
        true,
      )
    } else if (e.tool === 'NotebookEdit') {
      if (e.cell_type !== 'markdown' && e.edit_mode !== 'delete') {
        // a notebook that exists but can't be read (over 4 MiB) asks when the new cell could write
        const read = await readOrNull($, e.notebook_path)
        const before = notebookCode(read ?? '')
        const after = `${before}\n${e.new_source}`
        const hits = writeHits(before, after, e.new_source)
        const name = short(e.notebook_path)
        const blind = pythonBlind(after).filter(b => !pythonBlind(before).includes(b))
        scan = {
          found: hits.length ? [`${hits.join('; ')} in ${name}`] : [],
          unseen: [...(read === null && !hits.length && touches(e.new_source) ? [name] : []), ...blind.map(b => `${b} in ${name}`)],
        }
      }
    }
    const { found, unseen } = scan
    if (!found.length && !unseen.length) return next(e)
    const summary = [...found, ...(unseen.length ? [`could not inspect ${unseen.join(', ')}`] : [])].join('; ')
    const title = found.length ? undefined : 'Hardware write check'
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
