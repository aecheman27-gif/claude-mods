// Pure detection: no `$`, so the tests reach every rule directly.
// Python is scrubbed first (comments dropped, string bodies replaced by
// numbered placeholders), so a mention in a comment or a string never matches.

export type Scrubbed = { code: string; strings: string[] }

const PLACEHOLDER = (n: number) => `"§${n}§"`

export function scrubPython(src: string): Scrubbed {
  const strings: string[] = []
  let code = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === '"' || ch === "'") {
      const triple = src.startsWith(ch.repeat(3), i)
      const close = triple ? ch.repeat(3) : ch
      let j = i + close.length
      let body = ''
      while (j < src.length) {
        if (src[j] === '\\') {
          body += src.slice(j, j + 2)
          j += 2
          continue
        }
        if (src.startsWith(close, j)) break
        if (!triple && src[j] === '\n') break
        body += src[j]
        j++
      }
      strings.push(body)
      code += PLACEHOLDER(strings.length - 1)
      i = j + close.length
      continue
    }
    code += ch
    i++
  }
  return { code, strings }
}

export const PRINTER_TOPIC = /(device\/[^/\s]+\/request|printer|octoprint|klipper|moonraker|prusa|bambu)/i

const CALL = (name: string) => new RegExp(`\\.\\s*(?:${name})\\s*\\(`)

/** Hardware writes in one Python source, each a short label; empty when none. */
export function pythonHits(src: string): string[] {
  const { code, strings } = scrubPython(src)
  const hits: string[] = []

  if (/\bnidaqmx\b/.test(code)) {
    const kinds = [
      /\bdo_channels\s*\.\s*add_do_/.test(code) && 'DO',
      /\bao_channels\s*\.\s*add_ao_/.test(code) && 'AO',
    ].filter(Boolean)
    const writes = CALL('write|start').test(code)
    const streamWriter = /\b(Digital|Analog)\w*Writer\b/.test(code) && CALL('write_\\w+').test(code)
    if (kinds.length && (writes || streamWriter)) hits.push(`nidaqmx ${kinds.join('/')} write`)
  }

  if (/\b(pymodbus|Modbus\w*Client)\b/.test(code)) {
    const m = /\.\s*(write_coils?|write_registers?)\s*\(/.exec(code)
    if (m) hits.push(`pymodbus ${m[1]}`)
  }

  if (/^\s*(import\s+serial\b|from\s+serial\b)/m.test(code) && /\b(Serial|serial_for_url)\s*\(/.test(code) && CALL('write').test(code)) {
    hits.push('pyserial write')
  }

  if (CALL('publish').test(code)) {
    const topic = strings.find(s => PRINTER_TOPIC.test(s))
    if (topic !== undefined) hits.push(`MQTT publish to ${topic}`)
  }

  return hits
}

const TOUCHES = /(\.\s*(write\w*|start|publish)\s*\(|add_(do|ao)_|\bSerial\s*\()/

/**
 * Whether writing `after` over `before` puts hardware-writing code in place:
 * hits the old file lacked, or hits it had that the new text itself touches.
 */
export function writeHits(before: string, after: string, changed: string): string[] {
  const now = pythonHits(after)
  if (now.length === 0) return []
  const had = new Set(pythonHits(before))
  const isNew = now.some(h => !had.has(h))
  return isNew || TOUCHES.test(scrubPython(changed).code) ? now : []
}

export const isPythonFile = (path: string) => /\.(py|pyw)$/i.test(path)

// ---------------------------------------------------------------- shells

/**
 * Marks text the shell fills in at run time ($VAR, $( ), backticks, an
 * expanding heredoc). Code, paths and stdin carrying it can't be inspected.
 */
export const DYN = '\u0000'
const VAR_START = /[A-Za-z_{0-9@*#?!$:]/

export type Segment = { words: string[]; index: number }
export type Shell = {
  segments: Segment[][]
  heredocs: { target?: string; body: string; segment: number }[]
  /** Commands handed to another shell that can't be read here, e.g. "bash stdin". */
  opaque: string[]
}

// PowerShell's ` escapes inside "..." (`0 is dropped so it can't fake DYN), and Bash's $'...' escapes.
const PS_ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', '0': '' }
const C_ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', '\\': '\\', "'": "'", '"': '"' }

/** Index of the `)` closing the `(` at `open`, quotes skipped; src.length when unclosed. */
function closeParen(src: string, open: number, ps: boolean): number {
  const esc = ps ? '`' : '\\'
  let depth = 0
  for (let j = open; j < src.length; j++) {
    const c = src[j]
    if (c === esc) j++
    else if (c === "'") {
      const e = src.indexOf("'", j + 1)
      if (e === -1) return src.length
      j = e
    } else if (c === '"') {
      j++
      while (j < src.length && src[j] !== '"') j += src[j] === esc ? 2 : 1
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return j
  }
  return src.length
}

/** Index of the backtick closing the one at `open`; src.length when unclosed. */
function closeTick(src: string, open: number): number {
  for (let j = open + 1; j < src.length; j++) {
    if (src[j] === '\\') j++
    else if (src[j] === '`') return j
  }
  return src.length
}

/**
 * Splits a Bash or PowerShell command into pipelines of words, quotes
 * resolved, with heredoc and here-string bodies kept as words of their own.
 * A pipeline is the segments joined by `|`; pipelines are split by ; & && ||
 * newlines, parentheses and (PowerShell) braces. What runs inside $( ),
 * backticks, ( ), <( ), `bash -c`, `cmd /c`, `pwsh -Command`, `iex` and a
 * shell fed by a heredoc or a pipe is parsed too and added as pipelines of its
 * own. Good enough to find what program runs, not a full shell.
 */
export function parseShell(src: string, ps: boolean): Shell {
  const pipelines: Segment[][] = [[{ words: [], index: 0 }]]
  const heredocs: Shell['heredocs'] = []
  const opaque: string[] = []
  const nested: { src: string; ps: boolean }[] = []
  const pendingHeredocs: { tag: string; strip: boolean; segment: number; target?: string; expands: boolean }[] = []
  let word: string | null = null
  let segIndex = 0
  const cur = () => pipelines[pipelines.length - 1]
  const seg = () => cur()[cur().length - 1]
  const flush = () => {
    if (word !== null) seg().words.push(word)
    word = null
  }
  const split = () => {
    flush()
    segIndex++
    pipelines.push([{ words: [], index: segIndex }])
  }
  /** Queues `inner` to be parsed as commands; the current word gets its unknown output. */
  const substitute = (inner: string, text: string) => {
    nested.push({ src: inner, ps })
    word = (word ?? '') + DYN + text
  }
  /** Queues what an expanding heredoc or @"..."@ runs; DYN-marks it when the shell fills anything in. */
  const expand = (text: string): string => {
    let dyn = false
    for (let j = 0; j < text.length; j++) {
      if (text[j] === '$' && text[j + 1] === '(') {
        const e = closeParen(text, j + 1, ps)
        nested.push({ src: text.slice(j + 2, e), ps })
        dyn = true
        j = e
      } else if (!ps && text[j] === '`') {
        const e = closeTick(text, j)
        nested.push({ src: text.slice(j + 1, e), ps })
        dyn = true
        j = e
      } else if (text[j] === '$' && VAR_START.test(text[j + 1] ?? '')) dyn = true
    }
    return dyn ? DYN + text : text
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    // PowerShell here-string: @' ... '@ or @" ... "@, closer at a line start
    if (ps && ch === '@' && (next === "'" || next === '"') && word === null) {
      const start = src.indexOf('\n', i)
      const end = src.indexOf(`\n${next}@`, start)
      if (start !== -1 && end !== -1) {
        const body = src.slice(start + 1, end).replace(/\r$/, '')
        seg().words.push(next === '"' ? expand(body) : body)
        i = end + 3
        continue
      }
    }
    // a comment runs nothing
    if (ch === '#' && word === null) {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === "'") {
      // literal; PowerShell writes a quote inside as ''
      let j = i + 1
      let body = ''
      for (;;) {
        const e = src.indexOf("'", j)
        if (e === -1) {
          body += src.slice(j)
          j = src.length
          break
        }
        body += src.slice(j, e)
        j = e + 1
        if (!(ps && src[j] === "'")) break
        body += "'"
        j++
      }
      word = (word ?? '') + body
      i = j
      continue
    }
    if (!ps && ch === '$' && next === "'") {
      let j = i + 2
      let body = ''
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < src.length) {
          body += C_ESC[src[j + 1]] ?? src.slice(j, j + 2)
          j += 2
          continue
        }
        body += src[j++]
      }
      word = (word ?? '') + body
      i = j + 1
      continue
    }
    if (ch === '"') {
      // Bash: \ escapes only $ ` " \ and newline here, so "C:\work\x.py" keeps
      // its backslashes. PowerShell: ` escapes and "" is a quote. Both run $( ).
      let j = i + 1
      let body = ''
      while (j < src.length) {
        const c = src[j]
        if (c === '"') {
          if (!(ps && src[j + 1] === '"')) break
          body += '"'
          j += 2
          continue
        }
        if (!ps && c === '\\' && j + 1 < src.length && '$`"\\\n'.includes(src[j + 1])) {
          if (src[j + 1] !== '\n') body += src[j + 1]
          j += 2
          continue
        }
        if (ps && c === '`' && j + 1 < src.length) {
          body += PS_ESC[src[j + 1]] ?? src[j + 1]
          j += 2
          continue
        }
        if ((c === '$' && src[j + 1] === '(') || (!ps && c === '`')) {
          const e = c === '`' ? closeTick(src, j) : closeParen(src, j + 1, ps)
          nested.push({ src: src.slice(c === '`' ? j + 1 : j + 2, e), ps })
          body += DYN + src.slice(j, e + 1)
          j = e + 1
          continue
        }
        if (c === '$' && VAR_START.test(src[j + 1] ?? '')) body += DYN
        body += c
        j++
      }
      word = (word ?? '') + body
      i = j + 1
      continue
    }
    if ((ch === '$' || (ps && ch === '@')) && next === '(') {
      const e = closeParen(src, i + 1, ps)
      substitute(src.slice(i + 2, e), src.slice(i, e + 1))
      i = e + 1
      continue
    }
    if (!ps && ch === '`') {
      const e = closeTick(src, i)
      substitute(src.slice(i + 1, e), src.slice(i, e + 1))
      i = e + 1
      continue
    }
    if (ps && ch === '`' && i + 1 < src.length) {
      // PowerShell escape outside quotes; ` at a line end continues the line
      if (next === '\r' && src[i + 2] === '\n') i++
      else if (next !== '\n') word = (word ?? '') + next
      i += 2
      continue
    }
    if (ch === '(') {
      // a subshell, or a value an inner command computes
      const e = closeParen(src, i, ps)
      if (word === null && seg().words.length === 0) nested.push({ src: src.slice(i + 1, e), ps })
      else substitute(src.slice(i + 1, e), src.slice(i, e + 1))
      i = e + 1
      continue
    }
    if (ch === ')' || (ps && (ch === '{' || ch === '}'))) {
      split()
      i++
      continue
    }
    if (ch === '$' && VAR_START.test(next ?? '')) {
      const close = next === '{' ? src.indexOf('}', i) : i
      const end = close === -1 ? src.length : close + 1
      word = (word ?? '') + DYN + src.slice(i, end)
      i = end
      continue
    }
    if (!ps && ch === '\\' && i + 1 < src.length) {
      if (next !== '\n') word = (word ?? '') + next
      i += 2
      continue
    }
    if (!ps && src.startsWith('<<<', i)) {
      flush()
      seg().words.push('<<<')
      i += 3
      continue
    }
    if (!ps && ch === '<' && next === '<') {
      flush()
      let j = i + 2
      const strip = src[j] === '-'
      if (strip) j++
      while (src[j] === ' ') j++
      const m = /^(['"]?)([A-Za-z_][\w-]*)\1/.exec(src.slice(j))
      if (m) {
        const words = seg().words
        const gt = words.lastIndexOf('>')
        const target = gt !== -1 ? words[gt + 1] : undefined
        pendingHeredocs.push({ tag: m[2], strip, segment: segIndex, target, expands: !m[1] })
        i = j + m[0].length
        continue
      }
    }
    if (ch === '\n' || ch === ';' || (ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      flush()
      if (ch === '\n' && pendingHeredocs.length) {
        let pos = i + 1
        for (const h of pendingHeredocs.splice(0)) {
          const lines: string[] = []
          while (pos < src.length) {
            const nl = src.indexOf('\n', pos)
            const line = src.slice(pos, nl === -1 ? src.length : nl).replace(/\r$/, '')
            pos = nl === -1 ? src.length : nl + 1
            if ((h.strip ? line.replace(/^\t+/, '') : line) === h.tag) break
            lines.push(line)
          }
          const body = lines.join('\n')
          heredocs.push({ target: h.target, body: h.expands ? expand(body) : body, segment: h.segment })
        }
        i = pos
      } else {
        i += ch === '&' || ch === '|' ? 2 : 1
      }
      segIndex++
      pipelines.push([{ words: [], index: segIndex }])
      continue
    }
    if (ch === '&') {
      if (next === '>') {
        // &> file
        flush()
        seg().words.push('>')
        i += src[i + 2] === '>' ? 3 : 2
        continue
      }
      // PowerShell's call operator starts a command; anywhere else & ends one
      if (ps && word === null && seg().words.length === 0) seg().words.push('&')
      else split()
      i++
      continue
    }
    if (ch === '|') {
      flush()
      segIndex++
      cur().push({ words: [], index: segIndex })
      i += next === '&' ? 2 : 1
      continue
    }
    if (!ps && (ch === '<' || ch === '>') && next === '(') {
      // <( ) and >( ) run a command; the word is a pipe path
      flush()
      const e = closeParen(src, i + 1, ps)
      substitute(src.slice(i + 2, e), src.slice(i, e + 1))
      i = e + 1
      continue
    }
    if (ch === '>' || ch === '<') {
      if (word !== null && /^\d+$/.test(word)) word = null // the fd in 2>
      flush()
      seg().words.push(ch)
      i += next === ch ? 2 : 1
      if (ch === '>' && src[i] === '|') i++
      const fd = /^&(\d+|-)/.exec(src.slice(i))
      if (fd) {
        seg().words.push(fd[0])
        i += fd[0].length
      }
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush()
      i++
      continue
    }
    word = (word ?? '') + ch
    i++
  }
  flush()
  const segments = pipelines.map(p => p.filter(s => s.words.length > 0)).filter(p => p.length > 0)
  for (const p of segments) {
    for (let s = 0; s < p.length; s++) {
      const to = handedOn(p[s].words)
      if (!to) continue
      if (to.src !== undefined) nested.push({ src: to.src, ps: to.ps })
      else if (!to.stdin) opaque.push(to.name)
      else {
        // a shell reading its commands from a heredoc or a pipe
        const doc = heredocs.find(h => h.segment === p[s].index && !h.target)
        const text = doc ? doc.body.replace(DYN, '') : s > 0 ? piped(p[s - 1].words) : undefined
        if (text !== undefined) nested.push({ src: text, ps: to.ps })
        else if (s > 0) opaque.push(`${to.name} stdin`)
      }
    }
  }
  for (const n of nested) {
    const sub = parseShell(n.src, n.ps)
    const shift = segIndex + 1
    for (const p of sub.segments) segments.push(p.map(x => ({ ...x, index: x.index + shift })))
    for (const h of sub.heredocs) heredocs.push({ ...h, segment: h.segment + shift })
    opaque.push(...sub.opaque)
    segIndex = shift + Math.max(0, ...sub.segments.flat().map(x => x.index), ...sub.heredocs.map(h => h.segment))
  }
  return { segments, heredocs, opaque }
}

const base = (w: string) => w.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()
// python, python3, python3.12, python3.13t, pythonw, py, pyw, with any directory and .exe
const isPython = (w: string) => /^(pythonw?(\d+(\.\d+)*t?)?|pyw?)$/.test(base(w))
const PY_ARG_FLAGS = new Set(['-X', '-W', '-Q'])
// `python -m` targets that never run project code
const QUIET_MODULES = new Set([
  'pip', 'venv', 'ensurepip', 'virtualenv', 'pipx', 'build', 'twine', 'pydoc', 'py_compile', 'compileall', 'json.tool',
  'http.server', 'site', 'sysconfig', 'platform', 'tabnanny', 'black', 'ruff', 'isort', 'mypy', 'flake8', 'pylint', 'pyright',
  // test runners: treated like the bare `pytest` command, which is not inspected either; asking on
  // every test run would teach "Run it" by reflex (a known gap: tests that drive hardware)
  'pytest', 'unittest',
])

// Programs that run the rest of their words as a command: the options that
// take a value, and how many plain words come before the command.
const WRAPPERS = new Map<string, { arg?: RegExp; skip?: number } | null>([
  ...['&', '!', '{', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', 'nohup', 'builtin'].map(w => [w, null] as const),
  ['time', {}],
  ['command', {}],
  ['exec', { arg: /^-a$/ }],
  ['sudo', { arg: /^-[ugCDpPrtTU]$|^--(user|group|chdir|prompt|role|type|other-user|host)$/ }],
  ['doas', { arg: /^-[uC]$/ }],
  ['env', { arg: /^-[uCS]$|^--(unset|chdir|split-string)$/ }],
  ['nice', { arg: /^-n$|^--adjustment$/ }],
  ['timeout', { arg: /^-[sk]$|^--(signal|kill-after)$/, skip: 1 }],
  ['xargs', { arg: /^-[aEdeLlnPsI]$|^--(arg-file|delimiter|eof|max-lines|max-args|max-procs|max-chars|replace|process-slot-var)$/ }],
  ['stdbuf', { arg: /^-[ioe]$/ }],
  ['watch', { arg: /^-n$|^--interval$/ }],
  ['wsl', { arg: /^-[du]$|^--(distribution|user|cd)$/ }],
])
const SAPS_ARG = /^-(windowstyle|workingdirectory|verb|redirectstandard\w+|credential)$/i

/** The command after leading VAR=x / $x = assignments and wrappers (sudo, timeout 30, xargs, do, then, ...). */
export function stripWrappers(words: string[]): { w: string[]; xargs: boolean } {
  let w = words
  let xargs = false
  while (w.length) {
    if (/^[A-Za-z_]\w*=/.test(w[0])) {
      w = w.slice(1)
      continue
    }
    if (w[0].startsWith(DYN + '$') && /^[-+*/]?=$/.test(w[1] ?? '')) {
      w = w.slice(2) // PowerShell: $out = python ...
      continue
    }
    const h = base(w[0])
    if (h === 'start-process' || h === 'saps' || h === 'start') {
      // Start-Process [-FilePath] python [-ArgumentList] "a.py --x"; cmd's start "" /wait python a.py
      const out: string[] = []
      for (let k = 1; k < w.length; k++) {
        if (SAPS_ARG.test(w[k])) k++
        else if (w[k] && !w[k].startsWith('-') && !/^\/\w+$/.test(w[k])) out.push(...(out.length ? w[k].split(/[\s,]+/).filter(Boolean) : [w[k]]))
      }
      w = out
      continue
    }
    if (!WRAPPERS.has(h)) break
    const spec = WRAPPERS.get(h)
    if (h === 'xargs') xargs = true
    w = w.slice(1)
    if (!spec) continue
    while (w.length && w[0].startsWith('-') && w[0] !== '-') {
      const opt = w[0]
      w = w.slice(spec.arg?.test(opt) ? 2 : 1)
      if (opt === '--') break
    }
    w = w.slice(spec.skip ?? 0)
  }
  return { w, xargs }
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash'])
const PS_ARG = /^-(ex|ep|executionpolicy|w|windowstyle|wd|workingdirectory|of|outputformat|if|inputformat|settingsfile|configurationname|v|version)$/

/** A pwsh -EncodedCommand argument (base64 UTF-16LE), or undefined. */
function decodePs(b64: string): string | undefined {
  try {
    const bin = atob(b64)
    let out = ''
    for (let k = 0; k + 1 < bin.length; k += 2) out += String.fromCharCode(bin.charCodeAt(k) | (bin.charCodeAt(k + 1) << 8))
    return out
  } catch {
    return undefined
  }
}

/**
 * The command text a segment hands to another shell (`src`), or that the shell
 * reads its commands from stdin (`stdin`); neither means it can't be decoded.
 */
function handedOn(words: string[]): { name: string; ps: boolean; src?: string; stdin?: boolean } | undefined {
  const w = stripWrappers(words).w
  if (!w.length) return undefined
  const h = base(w[0])
  // one word is the whole command ("python a.py"); several are re-quoted and joined
  const rest = (k: number) => (w.length === k + 1 ? w[k] : w.slice(k).map(x => (/\s/.test(x) ? `"${x}"` : x)).join(' '))
  if (SHELLS.has(h)) {
    for (let k = 1; k < w.length; k++) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w[k])) return w[k + 1] === undefined ? undefined : { name: h, ps: false, src: w[k + 1] }
      if (w[k] === '-o' || w[k] === '+o') k++
      else if (!/^[-+]/.test(w[k])) return undefined // runs a script file
    }
    return { name: h, ps: false, stdin: true }
  }
  if (h === 'cmd') {
    const k = w.findIndex(x => /^\/[ck]$/i.test(x))
    return k === -1 ? undefined : { name: h, ps: true, src: rest(k + 1) }
  }
  if (h === 'pwsh' || h === 'powershell') {
    for (let k = 1; k < w.length; k++) {
      const a = w[k].toLowerCase()
      if (/^-(c|co|com|comm|comma|comman|command)$/.test(a)) return { name: h, ps: true, src: rest(k + 1) }
      if (/^-(e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)$/.test(a)) return { name: `${h} -EncodedCommand`, ps: true, src: decodePs(w[k + 1] ?? '') }
      if (/^-(f|fi|fil|file)$/.test(a)) return undefined
      if (PS_ARG.test(a)) k++
      else if (!a.startsWith('-')) return h === 'powershell' ? { name: h, ps: true, src: rest(k) } : undefined
    }
    return { name: h, ps: true, stdin: true }
  }
  if (h === 'iex' || h === 'invoke-expression') return { name: h, ps: true, src: rest(1).replace(/^-command\s+/i, '') }
  return undefined
}

export type PythonRun =
  | { kind: 'code'; code: string; label: string }
  | { kind: 'script'; path: string }
  | { kind: 'stdin'; file?: string }
  | { kind: 'module'; module: string }
  | { kind: 'opaque'; what: string }

/** What Python's own arguments run. */
function pythonArgs(a: string[]): PythonRun | undefined {
  for (let k = 0; k < a.length; k++) {
    const x = a[k]
    if (/^(-V|--version|-h|--help|-\?)$/.test(x)) return undefined
    if (x === '-') return { kind: 'stdin' }
    if (PY_ARG_FLAGS.has(x)) {
      k++
      continue
    }
    const m = /^-[bBdEiIOPqRsSuvx]*([cm])([\s\S]*)$/.exec(x) // -c, -uc, -c'code', -mpkg
    if (m) {
      const value = m[2] || a[k + 1]
      if (value === undefined) return undefined
      if (m[1] === 'c') return { kind: 'code', code: value, label: 'python -c' }
      return QUIET_MODULES.has(value) ? undefined : { kind: 'module', module: value }
    }
    if (x.startsWith('-')) continue
    return { kind: 'script', path: x }
  }
  return { kind: 'stdin' }
}

/** The Python a segment's words run, if they run Python at all. */
export function pythonRun(words: string[]): PythonRun | undefined {
  // redirections: `> f` is dropped, `< f` and `<<< text` feed stdin
  let file: string | undefined
  let text: string | undefined
  const kept: string[] = []
  for (let k = 0; k < words.length; k++) {
    if (words[k] === '>') k++
    else if (words[k] === '<') file = words[++k]
    else if (words[k] === '<<<') text = words[++k]
    else kept.push(words[k])
  }
  let { w, xargs } = stripWrappers(kept)
  if (!w.length) return undefined
  const head = base(w[0])
  if (['uv', 'poetry', 'pipenv', 'conda', 'pdm', 'hatch', 'rye'].includes(head)) {
    const run = w.findIndex(x => x === 'run')
    if (run === -1) return undefined
    let rest = w.slice(run + 1)
    while (rest.length && rest[0].startsWith('-')) rest = rest.slice(rest[0].includes('=') || !/^--?(with|python|project|directory|env-file|from|n|name|p|prefix)$/.test(rest[0]) ? 1 : 2)
    if (!rest.length) return undefined
    if (/\.pyw?$/i.test(rest[0])) return { kind: 'script', path: rest[0] }
    w = rest
  }
  // `$PY x.py`: unknown program, so only Python-looking arguments count
  if (w[0].includes(DYN)) {
    const run = pythonArgs(w.slice(1))
    return run?.kind === 'code' || run?.kind === 'module' || (run?.kind === 'script' && /\.pyw?$/i.test(run.path)) ? run : undefined
  }
  if (!isPython(w[0])) return undefined
  const run = pythonArgs(w.slice(1))
  if (run?.kind !== 'stdin') return run
  if (text !== undefined) return { kind: 'code', code: text, label: 'python stdin' }
  if (xargs) return { kind: 'opaque', what: 'python args from xargs' }
  return file !== undefined ? { kind: 'stdin', file } : run
}

/** The MQTT printer topic a `mosquitto_pub` segment publishes to, if any. */
export function mosquittoTopic(words: string[]): string | undefined {
  const w = stripWrappers(words).w
  if (!w.length || base(w[0]) !== 'mosquitto_pub') return undefined
  for (let k = 1; k < w.length; k++) {
    if (w[k] === '-t' || w[k] === '--topic') {
      const t = w[k + 1] ?? ''
      return PRINTER_TOPIC.test(t) ? t : undefined
    }
  }
  return undefined
}

/** Text a pipeline's earlier segment feeds to stdin: echo/printf/here-string/Write-Output. */
export function piped(words: string[]): string | undefined {
  if (!words.length) return undefined
  const h = base(words[0])
  if (['echo', 'printf', 'write-output'].includes(h)) {
    const text = words.slice(1).filter(x => !/^-/.test(x)).join(' ')
    return h === 'printf' || words.includes('-e') ? text.replace(/\\n/g, '\n').replace(/\\t/g, '\t') : text
  }
  // a lone here-string or quoted literal; a lone bare word is a command whose output is unknown
  if (words.length === 1 && /\s/.test(words[0])) return words[0]
  return undefined
}

/** Files a pipeline's earlier segment cats into stdin. */
export function catted(words: string[]): string | undefined {
  if (words.length >= 2 && ['cat', 'type', 'get-content', 'gc'].includes(base(words[0]))) return words.filter(x => !x.startsWith('-'))[1]
  return undefined
}

/** Where a cd-like segment moves to: a path, null when it can't be told (cd, cd -, cd ~, cd $X), undefined when it is no cd. */
export function cdTarget(words: string[]): string | null | undefined {
  const w = stripWrappers(words).w
  if (!w.length || !['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'].includes(base(w[0]))) return undefined
  const to = w.slice(1).filter(x => !/^(-[PLe@]|-path|-literalpath|-passthru|\/d)$/i.test(x))[0]
  return to === undefined || to === '-' || to.startsWith('~') || to.includes(DYN) ? null : to
}
