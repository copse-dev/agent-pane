import { expectArray, isRecord } from '@copse/std/unknown-value.ts'

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

/** Strip display projection provenance that only main may grant after review. */
export function withoutMainOwnedMessageFields(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const attachmentValue = payload['attachments']
  if (!Array.isArray(attachmentValue)) return payload
  const attachments = expectArray(attachmentValue)
  return {
    ...payload,
    attachments: attachments.map((attachment) => {
      if (!isRecord(attachment)) return attachment
      const { projection: _projection, ...rendererFields } = attachment
      return rendererFields
    }),
  }
}

/** `payload` without the fields only main may write. */
export function withoutMainOwnedThreadFields(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => !MAIN_OWNED_THREAD_FIELDS.includes(key)),
  )
}

/** Renderer-created threads cannot mint projection provenance in first messages. */
export function withoutMainOwnedThreadCreateFields(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const rendererFields = withoutMainOwnedThreadFields(payload)
  const messageValue = rendererFields['messages']
  if (!Array.isArray(messageValue)) return rendererFields
  const messages = expectArray(messageValue)
  return {
    ...rendererFields,
    messages: messages.map((message) =>
      isRecord(message) ? withoutMainOwnedMessageFields(message) : message,
    ),
  }
}
