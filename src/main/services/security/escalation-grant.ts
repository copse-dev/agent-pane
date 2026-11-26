/**
 * Session-only, thread-scoped grants to run commands outside the sandbox for
 * the same local reasons the user already approved there.
 *
 * In one brevet-card thread the user answered 110 "Run outside sandbox?"
 * prompts and could remember three: the only remember option was a trusted
 * command, offered only in trusted projects. Most prompts repeated one shape:
 * a scratch file under `/tmp`, an inline `node -e`, a project script.
 *
 * A grant names reason *kinds*, never a command. A later escalation is covered
 * only when every one of its reasons is a granted kind, so a grant for `/tmp`
 * paths never covers a download, an install, a push or a substitution: those
 * kinds are not grantable at all, because outside the sandbox each reaches
 * the network or runs code nobody can read. The caller still runs the Guarded
 * YOLO harm gate on every covered command, so credential reads, destructive
 * commands and the rest of that list keep their prompt.
 *
 * Grants die with the process and are never shared between threads. The
 * decision log records the approval that made a grant and each use of it.
 */

/**
 * The grantable kinds. Paths that can name the user's own files (`~/`, `../`,
 * other absolute paths) are left out, so a grant never covers `>> ~/.zshrc`;
 * `/tmp` is machine-wide scratch. Opaque local code is the shape users approve
 * over and over, and a loopback request names only this machine.
 */
const GRANTABLE_REASONS: ReadonlySet<string> = new Set([
  'global temp path (/tmp/)',
  'loopback request (curl/wget)',
  'inline script (interpreter -c/-e/--eval)',
  'runs a local script via an interpreter (contents opaque to analysis)',
  'executes an in-workspace file directly (contents opaque to analysis)',
  'heredoc script fed to an interpreter',
])

/**
 * The grantable kinds behind an escalation's reasons, or null when any reason
 * is not grantable or there are none. Null means no grant is offered and none
 * applies.
 */
export function grantableEscalationKinds(reasons: readonly string[]): string[] | null {
  if (reasons.length === 0) return null
  const kinds = new Set<string>()
  for (const reason of reasons) {
    if (!GRANTABLE_REASONS.has(reason)) return null
    kinds.add(reason)
  }
  return [...kinds].sort()
}

/** A few words per kind for the remember label; kinds sharing words merge. */
const KIND_NOUNS: ReadonlyMap<string, string> = new Map([
  ['global temp path (/tmp/)', '/tmp files'],
  ['loopback request (curl/wget)', 'requests to this machine'],
  ['inline script (interpreter -c/-e/--eval)', 'inline scripts'],
  ['heredoc script fed to an interpreter', 'inline scripts'],
  ['runs a local script via an interpreter (contents opaque to analysis)', 'project scripts'],
  ['executes an in-workspace file directly (contents opaque to analysis)', 'project scripts'],
])

/** Footer copy naming what "Allow for this chat" will cover, in the user's words. */
export function escalationGrantFooter(kinds: readonly string[]): string {
  const nouns = [...new Set(kinds.map((kind) => KIND_NOUNS.get(kind) ?? kind))]
  const list =
    nouns.length <= 1
      ? (nouns[0] ?? '')
      : `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1] ?? ''}`
  return (
    `Allow for this chat also runs later commands here outside the sandbox when they only involve ${list}, ` +
    'until Copse quits. Downloads, installs, pushes and your home folder still ask.'
  )
}

const grants = new Map<string, Set<string>>()

export function grantEscalationKinds(threadId: string, kinds: readonly string[]): void {
  const granted = grants.get(threadId) ?? new Set<string>()
  for (const kind of kinds) granted.add(kind)
  grants.set(threadId, granted)
}

export function hasEscalationGrant(threadId: string, kinds: readonly string[]): boolean {
  const granted = grants.get(threadId)
  return granted !== undefined && kinds.length > 0 && kinds.every((kind) => granted.has(kind))
}

export function clearEscalationGrants(): void {
  grants.clear()
}
