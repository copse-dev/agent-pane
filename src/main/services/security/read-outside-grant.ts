import { isGuardedYoloActive } from './guarded-yolo.ts'

/**
 * Session-only, thread-scoped "may read outside the project" ledger.
 *
 * Granted when the user approves a read-outside-the-project command with the
 * prompt's primary button, rather than its "Approve this command" one. Nothing
 * is read from or written to settings: a grant dies with the process, so a
 * restart can never resurrect one, and it is never shared between threads.
 *
 * An active Guarded YOLO thread also counts as holding the grant: that mode
 * pre-arms the same outside-read authority (credential / `~` / `/` refusals
 * still apply on every later command). Disabling YOLO drops this implied grant;
 * an explicit approval grant is independent and survives.
 *
 * The grant authorises no command by itself. Every later command is re-analysed
 * by `read-outside-project.ts` and must independently prove it is a plain read
 * of non-credential paths — so the grant removes the *prompt* for that shape,
 * not the checks.
 *
 * This set is the mechanism, not the record. The decision to grant is written to
 * the durable decision log (thread spine `decision` lines) by the gate, along with
 * the paths that prompted it and every later command the grant covers — so a
 * grant that has evaporated from memory is still answerable after the fact:
 * `scope: "external-read"` with `remembered: true` is the moment it was made.
 */
const grantedThreads = new Set<string>()

export function grantReadOutsideProject(threadId: string): void {
  grantedThreads.add(threadId)
}

export function hasReadOutsideProjectGrant(threadId: string | null): boolean {
  return (
    threadId !== null && (grantedThreads.has(threadId) || isGuardedYoloActive(threadId))
  )
}

/** Drop every grant. For tests and teardown; not wired to any user action. */
export function clearReadOutsideProjectGrants(): void {
  grantedThreads.clear()
}
