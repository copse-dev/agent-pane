/**
 * Which transcript writes belong to main.
 *
 * Main reduces the chunks of every turn it dispatches and persists the result
 * itself (`src/main/services/turn-transcript-writer.ts`); it marks those chunks
 * with a `TranscriptStamp`. The window still draws them through the same
 * reducer, so the store events that used to trigger a renderer write — a
 * finalized message, a settled tool call, an anchored review — still fire. The
 * autosave asks here whether such an event came from a stamped chunk, and if so
 * writes nothing: the runtime has it, and a second writer would race it.
 *
 * Messages created by a stamped chunk stay main-owned after the turn ends, so a
 * label the window adds to one later (a small-model summary) is sent to main to
 * merge rather than written over main's copy.
 */
let applyingDepth = 0
const runtimeOwnedMessages = new Set<string>()

/** Apply one stamped chunk; store events it fires are not the window's to persist. */
export function applyRuntimeOwnedChunk(messageIds: readonly string[], apply: () => void): void {
  for (const id of messageIds) runtimeOwnedMessages.add(id)
  applyingDepth += 1
  try {
    apply()
  } finally {
    applyingDepth -= 1
  }
}

/** True while a stamped chunk is being applied to the store. */
export function isApplyingRuntimeOwnedChunk(): boolean {
  return applyingDepth > 0
}

/** True for a message main created and persists. */
export function isRuntimeOwnedMessage(messageId: string): boolean {
  return runtimeOwnedMessages.has(messageId)
}

/** Test-only: forget ownership between cases. */
export function __resetRuntimeTranscriptForTest(): void {
  applyingDepth = 0
  runtimeOwnedMessages.clear()
}
