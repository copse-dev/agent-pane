/**
 * Thread fields only the main process may write.
 *
 * `remoteAgentLink` is the authorization anchor for remote-artifact image
 * downloads (docs/plans/sandboxed-artifact-image-downloads.md): main records it
 * when it launches or imports a cloud agent. A renderer-supplied value, or a
 * stale renderer copy sent as `undefined`, must never set or erase it.
 *
 * `worktree` belongs to main's checkout lifecycle. Renderer copies of prepare,
 * rename or completion results cannot allocate or revive a checkout through
 * create/autosave. Its policy choice, deferred allocation marker and resolved
 * branch are equally main-owned: renderer values must not steer a pending
 * automation back into the shared project checkout. Explicit native
 * restore/adopt/clear operations write directly.
 */
const MAIN_OWNED_THREAD_FIELDS: readonly string[] = [
  'remoteAgentLink',
  'cursorAgentIds',
  'worktree',
  'worktreeChoice',
  'deferredWorktree',
  'gitBranch',
  'automation',
]

/** `payload` without the fields only main may write. */
export function withoutMainOwnedThreadFields(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => !MAIN_OWNED_THREAD_FIELDS.includes(key)),
  )
}
