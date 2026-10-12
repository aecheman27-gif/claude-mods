// What each tool row says: its label, icon, color and one-line target.

export const C = {
  bg: 'black',
  primary: 'cyan',
  ok: 'green',
  warn: '#FFB000',
  edit: 'magenta',
  dim: 'gray',
} as const

export type Look = { label: string; icon: string; color: string; target: string; verb: string }

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const firstLine = (s: string) => s.split(/\r?\n/)[0]
const tail = (p: string) => p.replace(/\\/g, '/').split('/').slice(-3).join('/')

export function look(tool: string, input: unknown): Look {
  const i = (input ?? {}) as Record<string, unknown>
  switch (tool) {
    case 'Bash':
      return { label: 'TOOL', icon: '❯', color: C.primary, target: firstLine(str(i.description) || str(i.command)), verb: 'Run' }
    case 'PowerShell':
      return { label: 'TOOL', icon: '❯', color: C.primary, target: firstLine(str(i.description) || str(i.command)), verb: 'Run' }
    case 'Read':
      return { label: 'READ', icon: '◇', color: C.primary, target: tail(str(i.file_path)), verb: 'Read' }
    case 'Write':
      return { label: 'EDIT', icon: '✚', color: C.edit, target: tail(str(i.file_path)), verb: 'Write' }
    case 'Edit':
      return { label: 'EDIT', icon: '✎', color: C.edit, target: tail(str(i.file_path)), verb: 'Edit' }
    case 'NotebookEdit':
      return { label: 'EDIT', icon: '✎', color: C.edit, target: tail(str(i.notebook_path)), verb: 'Edit' }
    case 'Grep':
    case 'Glob':
      return { label: 'FIND', icon: '⌕', color: C.primary, target: str(i.pattern), verb: 'Search' }
    case 'WebFetch':
    case 'WebSearch':
      return { label: 'NET', icon: '⇅', color: C.primary, target: str(i.url) || str(i.query), verb: 'Fetch' }
    case 'Agent':
      return { label: 'AGENT', icon: '◈', color: C.primary, target: str(i.description), verb: 'Agent' }
    case 'AskUserQuestion':
      return { label: 'ASK', icon: '?', color: C.warn, target: 'question for you', verb: 'Ask' }
    case 'Skill':
      return { label: 'SKILL', icon: '✦', color: C.primary, target: str(i.skill), verb: 'Skill' }
  }
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = ''] = tool.split('__')
    return { label: 'MCP', icon: '⬡', color: C.primary, target: `${server}:${name}`, verb: name || tool }
  }
  return { label: 'TOOL', icon: '⚙', color: C.primary, target: '', verb: tool }
}

/** `claude-opus-5-5[1m]` → `opus-5.5 [1m]`. */
export function shortModel(id: string): string {
  const m = /^(?:claude-)?([a-z]+)-(\d+)-(\d+)(.*)$/.exec(id)
  return m ? `${m[1]}-${m[2]}.${m[3]}${m[4] ? ' ' + m[4] : ''}` : id
}
