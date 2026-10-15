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

/** One name an import binds: `import a.b as c` is { name: 'a.b', as: 'c' }, `from .x import y` { from: '.x', name: 'y' }. */
export type PyImport = { from?: string; name: string; as?: string }

/** The imports in scrubbed Python, wherever a statement starts: a line, after `;` or a `:` (try: import x). */
export function pyImports(code: string): PyImport[] {
  const out: PyImport[] = []
  const re = /(?:^|[;:])[ \t]*(?:from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^;\n]*)|import[ \t]+([^;\n]*))/gm
  for (const m of code.matchAll(re)) {
    for (const part of (m[2] ?? m[3] ?? '').replace(/[()\\]/g, ' ').split(',')) {
      const [name, as] = part.trim().split(/\s+as\s+/)
      if (!name || !/^[\w.*]+$/.test(name)) continue
      const imp: PyImport = { name }
      if (m[1] !== undefined) imp.from = m[1]
      if (as) imp.as = as.trim()
      out.push(imp)
    }
  }
  return out
}

/** The imports of `lib` or a submodule of it. */
const importsOf = (imports: PyImport[], lib: string) =>
  imports.filter(i => {
    const mod = i.from ?? i.name
    return mod === lib || mod.startsWith(`${lib}.`)
  })
/** `names` and the aliases `from lib import name as alias` gives them, as a regex alternation. */
const named = (imports: PyImport[], names: string[]) =>
  [...names, ...imports.flatMap(i => (i.as && names.includes(i.name) ? [i.as] : []))].join('|')

/** Hardware writes in one Python source, each a short label; empty when none. */
export function pythonHits(src: string): string[] {
  const { code, strings } = scrubPython(src)
  const imports = pyImports(code)
  const hits: string[] = []

  if (/\bnidaqmx\b/.test(code)) {
    // add_do_/add_ao_ anywhere: task.do_channels.add_do_chan, or ch = task.do_channels; ch.add_do_chan
    const kinds = [/\badd_do_\w/.test(code) && 'DO', /\badd_ao_\w/.test(code) && 'AO'].filter(Boolean)
    const writes = CALL('write|start').test(code)
    const streamWriter = /\b(Digital|Analog)\w*Writer\b/.test(code) && CALL('write_\\w+').test(code)
    if (kinds.length && (writes || streamWriter)) hits.push(`nidaqmx ${kinds.join('/')} write`)
  }

  if (/\b(pymodbus|Modbus\w*Client)\b/.test(code)) {
    const m =
      /\.\s*(write_coils?|write_registers?|mask_write_register|readwrite_registers|write_file_record)\s*\(/.exec(code) ??
      /\b(\w*Write\w*Request)\s*\(/.exec(code) // client.execute(WriteSingleCoilRequest(...))
    if (m) hits.push(`pymodbus ${m[1]}`)
  }

  const serial = importsOf(imports, 'serial')
  if (serial.length && new RegExp(`\\b(${named(serial, ['Serial', 'serial_for_url', 'RS485'])})\\s*\\(`).test(code) && CALL('write|writelines').test(code)) {
    hits.push('pyserial write')
  }

  // client.publish(...), or paho.mqtt.publish's single() / multiple() under any alias
  const paho = importsOf(imports, 'paho')
  if (CALL('publish').test(code) || (paho.length && new RegExp(`\\b(${named(paho, ['single', 'multiple'])})\\s*\\(`).test(code))) {
    const topic = strings.find(s => PRINTER_TOPIC.test(s))
    if (topic !== undefined) hits.push(`MQTT publish to ${topic}`)
  }

  return hits
}

const HW_LIB = /\b(nidaqmx|pymodbus|serial|paho)\b/

/**
 * Python this check can't read beside a hardware library (named in code or a
 * string): exec, eval, compile, __import__, importlib.import_module. Each a
 * short label; empty when none.
 */
export function pythonBlind(src: string): string[] {
  const { code, strings } = scrubPython(src)
  if (!HW_LIB.test(code) && !strings.some(s => HW_LIB.test(s))) return []
  const calls = [...code.matchAll(/(?<![.\w])(exec|eval|compile|__import__)\s*\(|\b(import_module)\s*\(/g)]
  return [...new Set(calls.map(m => `${m[1] ?? m[2]}()`))]
}

const TOUCHES = /(\.\s*(write\w*|start|publish|mask_write_register|readwrite_registers)\s*\(|\b(single|multiple)\s*\(|add_(do|ao)_|\bSerial\s*\(|Write\w*Request|(?<![.\w])(exec|eval)\s*\()/

/** Whether Python text calls something that could be a hardware write, were its imports known. */
export const touches = (src: string) => TOUCHES.test(scrubPython(src).code)

/**
 * Whether writing `after` over `before` puts hardware-writing code in place:
 * hits the old file lacked, or hits it had that the new text itself touches.
 */
export function writeHits(before: string, after: string, changed: string): string[] {
  const now = pythonHits(after)
  if (now.length === 0) return []
  const had = new Set(pythonHits(before))
  const isNew = now.some(h => !had.has(h))
  return isNew || touches(changed) ? now : []
}

/** The shell commands IPython runs from notebook or ipython code: `!cmd` lines and `%run x.py`. */
export function ipythonShell(code: string): string {
  return code
    .split('\n')
    .flatMap(line => {
      const m = /^\s*(?:!(.+)|%run\s+(.+))$/.exec(line)
      return m ? [m[1] ?? `python ${m[2]}`] : []
    })
    .join('\n')
}

export const isPythonFile = (path: string) => /\.(py|pyw)$/i.test(path)
export const isNotebook = (path: string) => /\.ipynb$/i.test(path)
/** A file of shell commands; .bat/.cmd are read with the PowerShell rules, as `cmd /c` is. */
export const isShellScript = (path: string) => /\.(ps1|psm1|bat|cmd|sh|bash|zsh)$/i.test(path)
export const isPsScript = (path: string) => /\.(ps1|psm1|bat|cmd)$/i.test(path)

/** .NET serial writes in PowerShell (or C# it compiles): a System.IO.Ports SerialPort and a .Write/.WriteLine call. */
export const dotnetSerialWrite = (src: string) => /\bIO\.Ports\b/i.test(src) && /SerialPort/i.test(src) && /\.\s*Write(Line)?\s*\(/i.test(src)

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
  const pendingHeredocs: { tag: string; strip: boolean; segment: number; words: string[]; expands: boolean }[] = []
  let word: string | null = null
  let segIndex = 0
  const cur = () => pipelines[pipelines.length - 1]!
  const seg = () => cur()[cur().length - 1]!
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
          body += C_ESC[src[j + 1]!] ?? src.slice(j, j + 2)
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
        if (!ps && c === '\\' && j + 1 < src.length && '$`"\\\n'.includes(src[j + 1]!)) {
          if (src[j + 1] !== '\n') body += src[j + 1]
          j += 2
          continue
        }
        if (ps && c === '`' && j + 1 < src.length) {
          body += PS_ESC[src[j + 1]!] ?? src[j + 1]!
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
        // the segment's words, still growing: its `> f` may come after the <<EOF
        pendingHeredocs.push({ tag: m[2]!, strip, segment: segIndex, words: seg().words, expands: !m[1] })
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
          // `cat > f <<EOF` and `cat <<EOF > f` write the body to f; any other command reads it on stdin
          const gt = h.words.lastIndexOf('>')
          const target = gt !== -1 && h.words[0] === 'cat' ? h.words[gt + 1] : undefined
          heredocs.push({ target, body: h.expands ? expand(body) : body, segment: h.segment })
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
        // &> file, &>> file
        flush()
        seg().words.push(src[i + 2] === '>' ? '>>' : '>')
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
      seg().words.push(ch === '>' && next === '>' ? '>>' : ch) // >> appends
      i += next === ch ? 2 : 1
      if (ch === '>' && src[i] === '|') i++
      const fd = /^&(\d+|-)/.exec(src.slice(i))
      if (fd) {
        seg().words.push(fd[0]!)
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
      const to = handedOn(p[s]!.words)
      if (!to) continue
      if (to.src !== undefined) nested.push({ src: to.src, ps: to.ps })
      else if (!to.stdin) opaque.push(to.name)
      else {
        // a shell reading its commands from a heredoc or a pipe
        const doc = heredocs.find(h => h.segment === p[s]!.index && !h.target)
        const text = doc ? doc.body.replace(DYN, '') : s > 0 ? piped(p[s - 1]!.words) : undefined
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
// python, python3, python3.12, python3.13t, pythonw, py, pyw, ipython, ipython3, with any directory and .exe
const isPython = (w: string) => /^(i?pythonw?(\d+(\.\d+)*t?)?|pyw?)$/.test(base(w))
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
  ...['&', '!', '{', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', 'nohup', 'builtin', 'call'].map(w => [w, null] as const),
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
/** Words of a Windows command line, as Start-Process passes its joined -ArgumentList: "..." groups; a comma splits a list. */
const cmdline = (s: string) => [...s.matchAll(/"([^"]*)"?|[^\s,"]+/g)].map(m => m[1] ?? m[0])

/**
 * The program and arguments of Start-Process [-FilePath] python [-ArgumentList]
 * "-u a.py" | 'a','b' (parameter names may be cut short, -Name:value too), or
 * cmd's start "" /wait python a.py.
 */
function startProcess(w: string[]): string[] {
  let file: string | undefined
  let args: string[] | undefined
  const pos: string[] = []
  for (let k = 1; k < w.length; k++) {
    const x = w[k]!
    if (!pos.length && /^\/\w+$/.test(x)) {
      if (/^\/d$/i.test(x)) k++ // cmd start /d <dir>
      continue
    }
    const m = /^-([A-Za-z]+)(?::([\s\S]*))?$/.exec(x)
    if (!m) {
      if (x) pos.push(x)
      continue
    }
    const name = m[1]!.toLowerCase()
    if ('filepath'.startsWith(name) || name === 'path' || name === 'pspath') file = m[2] ?? w[++k]
    else if ('argumentlist'.startsWith(name) || name === 'args') {
      // one string, or a list: 'a','b' is one word here, 'a', 'b' several
      const list = [m[2] ?? w[++k] ?? '']
      while (list[list.length - 1]!.endsWith(',') && k + 1 < w.length) list.push(w[++k]!)
      args = list
    } else if (/^(wi|wo|v|r|c|e)/.test(name)) k++ // -WindowStyle, -WorkingDirectory, -Verb, -Redirect*, -Credential, -Environment take a value
  }
  file ??= pos.shift()
  return file === undefined ? [] : [file, ...cmdline((args ?? pos).join(' '))]
}

/**
 * The command after leading VAR=x / $x = assignments and wrappers (sudo,
 * timeout 30, xargs, do, then, Start-Process, ...). `saps`: it starts in a
 * process of its own, whose stdin is not this command's.
 */
export function stripWrappers(words: string[]): { w: string[]; xargs: boolean; saps: boolean } {
  let w = words
  let xargs = false
  let saps = false
  while (w.length) {
    if (/^[A-Za-z_]\w*=/.test(w[0]!)) {
      w = w.slice(1)
      continue
    }
    if (w[0]!.startsWith(DYN + '$') && /^[-+*/]?=$/.test(w[1] ?? '')) {
      w = w.slice(2) // PowerShell: $out = python ...
      continue
    }
    const h = base(w[0]!)
    if (h === 'start-process' || h === 'saps' || h === 'start') {
      w = startProcess(w)
      saps = true
      continue
    }
    if (!WRAPPERS.has(h)) break
    const spec = WRAPPERS.get(h)
    if (h === 'xargs') xargs = true
    w = w.slice(1)
    if (!spec) continue
    while (w.length && w[0]!.startsWith('-') && w[0] !== '-') {
      const opt = w[0]!
      w = w.slice(spec.arg?.test(opt) ? 2 : 1)
      if (opt === '--') break
    }
    w = w.slice(spec.skip ?? 0)
  }
  return { w, xargs, saps }
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
  const h = base(w[0]!)
  // one word is the whole command ("python a.py"); several are re-quoted and joined
  const rest = (k: number) => (w.length === k + 1 ? w[k]! : w.slice(k).map(x => (/\s/.test(x) ? `"${x}"` : x)).join(' '))
  if (SHELLS.has(h)) {
    for (let k = 1; k < w.length; k++) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w[k]!)) return w[k + 1] === undefined ? undefined : { name: h, ps: false, src: w[k + 1] }
      if (w[k] === '-o' || w[k] === '+o') k++
      else if (!/^[-+]/.test(w[k]!)) return undefined // runs a script file: scriptRun
    }
    return { name: h, ps: false, stdin: true }
  }
  if (h === 'cmd') {
    const k = w.findIndex(x => /^\/\/?[ck]$/i.test(x)) // //c: Git Bash's spelling of /c
    return k === -1 ? undefined : { name: h, ps: true, src: rest(k + 1) }
  }
  if (h === 'pwsh' || h === 'powershell') {
    for (let k = 1; k < w.length; k++) {
      const a = w[k]!.toLowerCase()
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

/** A segment's words without redirections, and what they feed stdin: `< f`, `<<< text`. */
function unredirected(words: string[]): { kept: string[]; file?: string; text?: string } {
  let file: string | undefined
  let text: string | undefined
  const kept: string[] = []
  for (let k = 0; k < words.length; k++) {
    if (words[k] === '>' || words[k] === '>>') k++
    else if (words[k] === '<') file = words[++k]
    else if (words[k] === '<<<') text = words[++k]
    else kept.push(words[k]!)
  }
  return { kept, file, text }
}

/**
 * The file of shell commands a segment runs: ./run.sh, .\flash.ps1, & x.ps1,
 * . x.ps1, source x.sh, bash run.sh, pwsh [-File] x.ps1, cmd /c x.bat (by way
 * of the nested parse). `ps`: read it with the PowerShell rules.
 */
export function scriptRun(words: string[], ps: boolean): { path: string; ps: boolean } | undefined {
  const w = stripWrappers(unredirected(words).kept).w
  if (!w.length) return undefined
  const h = base(w[0]!)
  const kind = (path: string, fallback: boolean) => ({ path, ps: isPsScript(path) || (fallback && !/\.(sh|bash|zsh)$/i.test(path)) })
  if ((h === '.' || h === 'source') && w[1] !== undefined) return kind(w[1], ps)
  if (SHELLS.has(h)) {
    for (let k = 1; k < w.length; k++) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w[k]!)) return undefined // handedOn's
      if (w[k] === '-o' || w[k] === '+o') k++
      else if (!/^[-+]/.test(w[k]!)) return { path: w[k]!, ps: false }
    }
    return undefined
  }
  if (h === 'pwsh' || h === 'powershell') {
    for (let k = 1; k < w.length; k++) {
      const a = w[k]!.toLowerCase()
      if (/^-(f|fi|fil|file)$/.test(a)) return w[k + 1] === undefined ? undefined : { path: w[k + 1]!, ps: true }
      if (/^-(c|co\w*|e|ec|en\w*)$/.test(a)) return undefined // -Command, -EncodedCommand: handedOn's
      if (PS_ARG.test(a)) k++
      else if (!a.startsWith('-')) return h === 'pwsh' ? { path: w[k]!, ps: true } : undefined // powershell: a command, handedOn's
    }
    return undefined
  }
  return isShellScript(w[0]!) ? kind(w[0]!, ps) : undefined
}

export type PythonRun =
  | { kind: 'code'; code: string; label: string }
  | { kind: 'script'; path: string }
  | { kind: 'stdin'; file?: string }
  | { kind: 'module'; module: string }
  | { kind: 'notebook'; paths: string[] }
  | { kind: 'opaque'; what: string }

/**
 * The notebooks `jupyter execute`, `jupyter nbconvert --execute` or `papermill`
 * runs (`w` from the program on); undefined when it runs none.
 */
function notebookRun(w: string[]): PythonRun | undefined {
  let h = base(w[0] ?? '')
  let rest = w.slice(1)
  if (h === 'jupyter' && rest[0] !== undefined) {
    h = `jupyter-${rest[0].toLowerCase()}`
    rest = rest.slice(1)
  }
  const runs = h === 'jupyter-execute' || h === 'papermill' || (h === 'jupyter-nbconvert' && rest.some(x => /^--execute\b/.test(x)))
  if (!runs) return undefined
  // papermill runs its input and writes its output; nbconvert and execute run every notebook named but --output's
  const paths = rest
    .filter((x, k) => !x.startsWith('-') && (/\.ipynb$/i.test(x) || x.includes(DYN)) && !/^--output(-dir)?$/.test(rest[k - 1] ?? ''))
    .slice(0, h === 'papermill' ? 1 : undefined)
  return paths.length ? { kind: 'notebook', paths } : undefined
}
const NOTEBOOK_MODULES: Record<string, string> = { jupyter: 'jupyter', nbconvert: 'jupyter-nbconvert', papermill: 'papermill' }

/** What Python's own arguments run. */
function pythonArgs(a: string[]): PythonRun | undefined {
  for (let k = 0; k < a.length; k++) {
    const x = a[k]!
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
      const runner = NOTEBOOK_MODULES[value]
      if (runner) return notebookRun([runner, ...a.slice(k + (m[2] ? 1 : 2))])
      return QUIET_MODULES.has(value) ? undefined : { kind: 'module', module: value }
    }
    if (x.startsWith('-')) continue
    return /\.ipynb$/i.test(x) ? { kind: 'notebook', paths: [x] } : { kind: 'script', path: x }
  }
  return { kind: 'stdin' }
}

/** The Python a segment's words run, if they run Python at all. */
export function pythonRun(words: string[]): PythonRun | undefined {
  // redirections: `> f` is dropped, `< f` and `<<< text` feed stdin
  const { kept, file, text } = unredirected(words)
  let { w, xargs, saps } = stripWrappers(kept)
  if (!w.length) return undefined
  const head = base(w[0]!)
  if (['uv', 'poetry', 'pipenv', 'conda', 'pdm', 'hatch', 'rye'].includes(head)) {
    const run = w.findIndex(x => x === 'run')
    if (run === -1) return undefined
    let rest = w.slice(run + 1)
    while (rest.length && rest[0]!.startsWith('-')) rest = rest.slice(rest[0]!.includes('=') || !/^--?(with|python|project|directory|env-file|from|n|name|p|prefix)$/.test(rest[0]!) ? 1 : 2)
    if (!rest.length) return undefined
    if (/\.pyw?$/i.test(rest[0]!)) return { kind: 'script', path: rest[0]! }
    w = rest
  }
  // `$PY x.py`: unknown program, so only Python-looking arguments count
  if (w[0]!.includes(DYN)) {
    const run = pythonArgs(w.slice(1))
    return run?.kind === 'code' || run?.kind === 'module' || (run?.kind === 'script' && /\.pyw?$/i.test(run.path)) ? run : undefined
  }
  // ./drive.py, .\drive.py: the shebang line or the py launcher runs it
  if (/\.pyw?$/i.test(w[0]!)) return { kind: 'script', path: w[0]! }
  if (!isPython(w[0]!)) return notebookRun(w)
  if (/^ipython/.test(base(w[0]!)) && /^(kernel|profile|history|locate)$/.test(w[1] ?? '')) return undefined // ipython kernel install, ...
  const run = pythonArgs(w.slice(1))
  if (run?.kind !== 'stdin') return run
  if (text !== undefined) return { kind: 'code', code: text, label: 'python stdin' }
  if (xargs) return { kind: 'opaque', what: 'python args from xargs' }
  if (file !== undefined) return { kind: 'stdin', file }
  return saps ? { kind: 'opaque', what: 'python under Start-Process' } : run
}

/** The MQTT printer topic a `mosquitto_pub` segment publishes to, if any. */
export function mosquittoTopic(words: string[]): string | undefined {
  const w = stripWrappers(words).w
  if (!w.length || base(w[0]!) !== 'mosquitto_pub') return undefined
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
  const h = base(words[0]!)
  if (['echo', 'printf', 'write-output'].includes(h)) {
    const text = words.slice(1).filter(x => !/^-/.test(x)).join(' ')
    return h === 'printf' || words.includes('-e') ? text.replace(/\\n/g, '\n').replace(/\\t/g, '\t') : text
  }
  // a lone here-string or quoted literal; a lone bare word is a command whose output is unknown
  if (words.length === 1 && /\s/.test(words[0]!)) return words[0]
  return undefined
}

/** Files a pipeline's earlier segment cats into stdin. */
export function catted(words: string[]): string | undefined {
  if (words.length >= 2 && ['cat', 'type', 'get-content', 'gc'].includes(base(words[0]!))) return words.filter(x => !x.startsWith('-'))[1]
  return undefined
}

// Programs that never change the files they name (a redirect of theirs still does).
const READERS = new Set([
  'cat', 'type', 'gc', 'get-content', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'findstr', 'select-string', 'sls',
  'wc', 'ls', 'dir', 'gci', 'get-childitem', 'stat', 'file', 'test', '[', '[[', 'diff', 'cmp', 'fc', 'compare-object', 'md5sum',
  'sha1sum', 'sha256sum', 'get-filehash', 'which', 'where', 'get-command', 'gcm', 'test-path', 'resolve-path', 'get-item', 'gi',
  'realpath', 'readlink', 'dirname', 'basename', 'du', 'echo', 'printf', 'write-output', 'write-host', 'cd', 'chdir', 'pushd', 'popd',
  'set-location', 'sl', 'black', 'isort', 'ruff', 'flake8', 'pylint', 'mypy', 'pyright', 'pytest', 'chmod', 'attrib', 'icacls',
  'touch', 'rm', 'del', 'erase', 'remove-item', 'ri', 'rmdir', 'mkdir', 'md', 'mosquitto_pub', 'jupyter', 'papermill',
])
const RUNNERS = new Set([...SHELLS, 'pwsh', 'powershell', 'cmd', '.', 'source', 'jupyter-execute', 'jupyter-nbconvert', 'iex', 'invoke-expression'])
const GIT_READS = new Set(['diff', 'log', 'show', 'status', 'add', 'blame', 'ls-files', 'grep', 'commit', 'rm', 'fetch', 'branch', 'tag', 'remote', 'config'])
const COPIERS = new Set(['cp', 'mv', 'copy', 'move', 'copy-item', 'cpi', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni', 'xcopy'])
const IN_PLACE = new Set(['sed', 'perl', 'awk', 'gawk', 'ruby'])

/**
 * The paths a segment may change, as written: its redirect targets; for cp/mv
 * and kin the destination; for sed/perl only with -i; for any other program
 * that is not a known reader, every word it names (`-o f`, `of=f`, `-OutFile:f`).
 */
export function writtenBy(words: string[]): string[] {
  const out: string[] = []
  for (let k = 0; k < words.length; k++) if ((words[k] === '>' || words[k] === '>>') && words[k + 1] !== undefined) out.push(words[++k]!)
  const w = stripWrappers(unredirected(words).kept).w
  if (!w.length) return out
  const h = base(w[0]!)
  const args = w.slice(1)
  // what runs code is read for what it runs (a script it names is its input, not its output)
  const runs = pythonRun(words) !== undefined || scriptRun(words, false) !== undefined || RUNNERS.has(h) || isPython(w[0]!)
  if (runs || READERS.has(h) || (h === 'git' && GIT_READS.has(args[0] ?? ''))) return out
  if (IN_PLACE.has(h)) return args.some(x => /^-[A-Za-z]*i|^--in-place/.test(x)) ? [...out, ...args] : out
  if (COPIERS.has(h)) {
    const d = args.findIndex(x => /^-(dest\w*|newname)$/i.test(x))
    const named = d === -1 ? undefined : args[d + 1]
    const pos = args.filter((x, k) => !x.startsWith('-') && !(d !== -1 && k === d + 1))
    const dest = named ?? pos.pop()
    if (dest === undefined) return out
    // into a folder (no extension, or a trailing separator): each source's name there
    const intoDir = /[\\/]$/.test(dest) || !/\.[^\\/]*$/.test(dest)
    return [...out, dest, ...(intoDir ? pos.map(s => `${dest.replace(/[\\/]$/, '')}/${s.replace(/^.*[\\/]/, '')}`) : [])]
  }
  return [...out, ...args.map(x => x.replace(/^-\w+:|^[\w-]*=/, ''))]
}

/**
 * A file a segment fills with literal text: echo/printf/Write-Output > f, a
 * here-string or literal piped to Set-Content / Out-File, or Set-Content f
 * -Value text. Undefined for anything else, appends included.
 */
export function literalWrite(pipeline: Segment[], s: number): { path: string; text: string } | undefined {
  const words = pipeline[s]!.words
  const h = base(words[0] ?? '')
  const redirects = words.filter(x => x === '>' || x === '>>' || x === '<' || x === '<<<')
  if (redirects.length === 1 && words[words.length - 2] === '>') {
    // only what echoes its words: a lone "quoted word" in Bash is a program, its output unknown
    const text = ['echo', 'printf', 'write-output'].includes(h) ? piped(words.slice(0, -2)) : undefined
    return text === undefined ? undefined : { path: words[words.length - 1]!, text }
  }
  if (redirects.length || !['set-content', 'sc', 'out-file'].includes(h)) return undefined
  let path: string | undefined
  let value: string | undefined
  for (let k = 1; k < words.length; k++) {
    const m = /^-([A-Za-z]+)(?::([\s\S]*))?$/.exec(words[k]!)
    if (!m) {
      if (path === undefined) path = words[k]
      else if (value === undefined) value = words[k]
      else return undefined
      continue
    }
    const name = m[1]!.toLowerCase()
    const arg = () => m[2] ?? words[++k]
    if (/^(filter|include|exclude|en\w*|wi\w*|st\w*)$/.test(name)) arg() // -Encoding, -Width, -Stream, ...
    else if (/^(p|pa|pat|path|pspath|fi\w*|li\w*|lp)$/.test(name)) path = arg()
    else if (/^v/.test(name)) value = arg()
    else if (!/^(nonewline|force|nocl\w*|confirm|whatif|passthru|asbytestream)$/.test(name)) return undefined // -Append and the unknown
  }
  const text = value ?? (s > 0 ? piped(pipeline[s - 1]!.words) : undefined)
  return path === undefined || text === undefined ? undefined : { path, text }
}

/** Where a cd-like segment moves to: a path, null when it can't be told (cd, cd -, cd ~, cd $X), undefined when it is no cd. */
export function cdTarget(words: string[]): string | null | undefined {
  const w = stripWrappers(words).w
  if (!w.length || !['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'].includes(base(w[0]!))) return undefined
  const to = w.slice(1).filter(x => !/^(-[PLe@]|-path|-literalpath|-passthru|\/d)$/i.test(x))[0]
  return to === undefined || to === '-' || to.startsWith('~') || to.includes(DYN) ? null : to
}
