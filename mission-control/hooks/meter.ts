// Pure helpers: token estimates, labels, bars and per-tool totals.

import type { Output } from '../types'

/** Rough tokens for text as the model reads it: about 4 characters a token. */
export const estimate = (text: string): number => Math.ceil(text.length / 4)

export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

export function bar(fraction: number, width: number): string {
  const w = Math.max(1, Math.floor(width))
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * w)
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

/** Green under 60%, yellow under 80%, red from there. */
export const tone = (percent: number): string => (percent >= 80 ? '#f87171' : percent >= 60 ? '#facc15' : '#4ade80')

/** `mcp__server__tool` reads as `server:tool`. */
export function toolName(tool: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  return m ? `${m[1]}:${m[2]}` : tool
}

export function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, Math.max(1, max - 1)) + '…' : t
}

/** Longest label kept per output: a heredoc command is not stored whole. */
export const LABEL_MAX = 160

/** What the call was about, from its arguments (the command, the file, the pattern), on one line of at most LABEL_MAX. */
export function labelOf(tool: string, input: Record<string, unknown>): string {
  const full = whole(tool, input)
  return oneLine(full.length > LABEL_MAX * 4 ? full.slice(0, LABEL_MAX * 4) : full, LABEL_MAX)
}

function whole(tool: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const base = (p: string) => p.replace(/\\/g, '/').split('/').pop() || p
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return s('command')
    case 'Read':
    case 'Write':
    case 'Edit':
      return base(s('file_path'))
    case 'NotebookEdit':
      return base(s('notebook_path'))
    case 'Grep':
    case 'Glob':
      return s('pattern')
    case 'WebFetch':
      return s('url')
    case 'WebSearch':
      return s('query')
    case 'Agent':
      return s('description')
    default:
      return ''
  }
}

export type ToolTotal = { tool: string; calls: number; tokens: number }

/** Tokens and calls per tool, biggest first. */
export function totals(outputs: readonly Output[]): ToolTotal[] {
  const by = new Map<string, ToolTotal>()
  for (const o of outputs) {
    const t = by.get(o.tool) ?? { tool: o.tool, calls: 0, tokens: 0 }
    t.calls++
    t.tokens += o.tokens
    by.set(o.tool, t)
  }
  return [...by.values()].sort((a, b) => b.tokens - a.tokens)
}
