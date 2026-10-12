// Pure text rules: what counts as a correction, and how a rule is added to a file.

const CORRECTION =
  /^\s*(no\b|nope\b|don'?t\b|do not\b|stop\b|never\b|always\b|i wish\b|i'?d rather\b|i would rather\b|instead\b|that'?s (wrong|not)\b|wrong\b|not like that\b|please don'?t\b|you should(n'?t)?\b|remember:)/i
const SECRET = /(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.)/
const MAX_PROMPT = 300
const MAX_RULE = 200

/** The rule a prompt offers, or undefined when it is not a correction worth keeping. */
export function ruleFrom(text: string): string | undefined {
  const t = text.trim()
  if (!t || t.startsWith('/') || t.length > MAX_PROMPT || SECRET.test(t) || !CORRECTION.test(t)) return undefined
  const remembered = /^\s*remember:\s*(.+)$/is.exec(t)
  const rule = (remembered ? remembered[1] : t).replace(/\s+/g, ' ').trim()
  if (rule.length < 4) return undefined
  return rule.length > MAX_RULE ? rule.slice(0, MAX_RULE - 1) + '…' : rule
}

export const HEADING = '## Learned rules'

export const SKILL_HEADER = `---
name: learned-rules
description: Rules the user taught Claude by correcting it. Follow them in all work in every project.
---
`

/**
 * The file with `- rule` added under the Learned rules heading, made if
 * missing; everything else in the file is kept as it was. Undefined when the
 * rule is already there.
 */
export function withRule(file: string, rule: string, header = ''): string | undefined {
  const nl = file.includes('\r\n') ? '\r\n' : '\n'
  const bullet = `- ${rule}`
  if (file.split(/\r?\n/).some(line => line.trim() === bullet)) return undefined
  let text = file === '' ? header.replace(/\n/g, nl) : file
  const at = text.indexOf(HEADING)
  if (at === -1) {
    const sep = text === '' ? '' : text.endsWith(nl + nl) ? '' : text.endsWith(nl) ? nl : nl + nl
    return `${text}${sep}${HEADING}${nl}${nl}${bullet}${nl}`
  }
  // insert at the end of that section: before the next heading of level 1-2, or at the end
  const after = at + HEADING.length
  const rest = text.slice(after)
  const next = rest.search(/\r?\n#{1,2} /)
  const end = next === -1 ? text.length : after + next
  const body = text.slice(0, end).replace(/(\r?\n)*$/, '')
  return `${body}${nl}${bullet}${nl}${text.slice(end).replace(/^(\r?\n)*/, next === -1 ? '' : nl)}`
}
