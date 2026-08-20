/**
 * The `/name` composer surface, shared by skills and subagents.
 *
 * Both are things a user runs by name, so they share one namespace and one
 * resolver rather than growing a second mention syntax. Cursor uses `/name` for
 * subagents too; Claude Code's `@agent-name` is the outlier, and a second
 * trigger character would mean two pickers and two parsers for one idea.
 *
 * The consequence is that names must be unique **across** skills and agents.
 * Skills win a collision — they are the incumbent surface, so no existing
 * `/name` changes meaning when agents arrive — and the shadowed agent is
 * reported in Settings rather than silently dropped.
 */

/** What a `/name` token can refer to. */
export type InvocableKind = 'skill' | 'agent'

export interface Invocable {
  name: string
  kind: InvocableKind
}

export interface ResolvedInvocation {
  name: string
  remainder: string
  /**
   * `null` when the text carries a leading `/name` that matches nothing known.
   * The caller reports it — a typo'd `/reviwer` must not be sent as a silent
   * plain message, and it must not be reported as an unknown *skill* when the
   * user was reaching for an agent.
   */
  kind: InvocableKind | null
}

const LEADING_INVOCATION_RE = /^\/([a-z0-9][a-z0-9-]*)\b(?:\s+(.*))?$/s

/** Escape regex metacharacters so a name can be embedded in a pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Match a `/name` token. Uses a negative lookahead for name characters as the
 * trailing boundary so `/demo` does not match inside `/demo-skill` (a plain
 * `\b` would, since `-` is a word boundary).
 */
function invocationTokenPattern(name: string): string {
  return `\\/${escapeRegExp(name)}(?![a-z0-9-])`
}

function stripInvocationToken(text: string, name: string): string {
  return text
    .replace(new RegExp(invocationTokenPattern(name)), '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse a leading `/name` prefix, without checking that the name is known. */
export function parseLeadingInvocation(text: string): { name: string; remainder: string } | null {
  const trimmed = text.trim()
  const match = trimmed.match(LEADING_INVOCATION_RE)
  if (!match) return null
  const name = match[1]
  if (name === undefined) return null
  return { name, remainder: (match[2] ?? '').trim() }
}

/**
 * Resolve an invocation from composer text: a leading `/name` first, then an
 * inline `/name` that matches something known.
 *
 * The inline pass only accepts known names, which is what stops a path like
 * `/Users/me/notes` from reading as an invocation. It scans longest-first so
 * `/deploy-web` wins over a `/deploy` that is also registered.
 */
export function resolveInvocation(
  text: string,
  invocables: readonly Invocable[],
): ResolvedInvocation | null {
  const kindOf = (name: string): InvocableKind | null =>
    invocables.find((entry) => entry.name === name)?.kind ?? null

  const leading = parseLeadingInvocation(text)
  if (leading) return { ...leading, kind: kindOf(leading.name) }

  const trimmed = text.trim()
  if (!trimmed || invocables.length === 0) return null

  const sorted = [...invocables].sort((a, b) => b.name.length - a.name.length)
  for (const { name, kind } of sorted) {
    const re = new RegExp(`(?:^|\\s)${invocationTokenPattern(name)}`)
    if (!re.test(trimmed)) continue
    return { name, kind, remainder: stripInvocationToken(trimmed, name) }
  }
  return null
}

/**
 * Merge skills and agents into one namespace, skills first.
 *
 * De-duplicated by name so a collision resolves the same way everywhere it is
 * asked — the picker, the composer resolver, and the submit path all read this
 * one list rather than each applying their own precedence.
 */
export function mergeInvocables(
  skillNames: readonly string[],
  agentNames: readonly string[],
): Invocable[] {
  const seen = new Set<string>()
  const merged: Invocable[] = []
  for (const name of skillNames) {
    if (seen.has(name)) continue
    seen.add(name)
    merged.push({ name, kind: 'skill' })
  }
  for (const name of agentNames) {
    if (seen.has(name)) continue
    seen.add(name)
    merged.push({ name, kind: 'agent' })
  }
  return merged
}
