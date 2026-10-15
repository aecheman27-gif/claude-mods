// Pure text rules: what counts as a correction, and how a rule is added to a file.

const CORRECTION =
  /^\s*(no\b|nope\b|don'?t\b|do not\b|stop\b|never\b|always\b|i wish\b|i'?d rather\b|i would rather\b|instead\b|that'?s (wrong|not)\b|wrong\b|not like that\b|please don'?t\b|you should(n'?t)?\b|remember:)/i
// Text that looks like it carries a secret; a prompt with any is never offered.
// The prompt may reach this before a redacting mod has scrubbed it, so it is
// checked here, locally, whatever runs after.
const SECRET = [
  /sk-[A-Za-z0-9_-]{16,}/, // API keys of the sk- form
  /\b[rsp]k_(live|test)_[A-Za-z0-9]{8,}/, // Stripe
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /AIza[0-9A-Za-z_-]{20,}/, // Google API key
  /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}/, // GitHub, GitLab
  /xox[abprs]-/, // Slack
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /eyJ[A-Za-z0-9_-]{20,}\./, // a JWT
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, // scheme://user:password@host
  /\b(password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*\S{4,}/i,
  /\[REDACTED\b/i, // a redacting mod's placeholder: the prompt held a secret
  /(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}/, // a long token of letters and digits
]
const MAX_PROMPT = 300
const MAX_RULE = 200

export const looksSecret = (text: string) => SECRET.some(re => re.test(text))

/**
 * The rule with each word that holds an @ in a code span: CLAUDE.md reads
 * `@path` as an import that loads that file into every session, and never
 * inside a code span.
 */
export function withoutImports(rule: string): string {
  return rule.replace(/\S*@\S*/g, word => {
    const [, lead = '', core = word, tail = ''] = /^([("'[]*)(.*?)([)"'\].,;:!?]*)$/.exec(word) ?? []
    if (/^`[^`]+`$/.test(core)) return word
    return `${lead}\`${core.replace(/`/g, '')}\`${tail}`
  })
}

/** The rule a prompt offers, or undefined when it is not a correction worth keeping. */
export function ruleFrom(text: string): string | undefined {
  const t = text.trim()
  if (!t || t.startsWith('/') || t.length > MAX_PROMPT || looksSecret(t) || !CORRECTION.test(t)) return undefined
  const remembered = /^\s*remember:\s*(.+)$/is.exec(t)
  const rule = (remembered?.[1] ?? t).replace(/\s+/g, ' ').trim()
  if (rule.length < 4) return undefined
  return withoutImports(rule.length > MAX_RULE ? rule.slice(0, MAX_RULE - 1) + '…' : rule)
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
