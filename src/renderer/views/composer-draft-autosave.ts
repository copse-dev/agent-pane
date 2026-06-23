/**
 * Debounced autosave for the composer draft text.
 *
 * The debounce captures the thread id at the moment the user types, but reads
 * the textarea value when the timer fires. If the user switches threads inside
 * the debounce window, the switch handler has already persisted the outgoing
 * thread's draft — so a late timer must NOT run, or it would clobber that draft
 * with the (now-different) textarea value of the thread we switched to.
 */
export interface ComposerDraftAutosaveOptions {
  getActiveThreadId: () => string | null
  getValue: () => string
  save: (threadId: string, value: string) => void
  delayMs?: number
}

export interface ComposerDraftAutosave {
  schedule: () => void
  cancel: () => void
}

const DEFAULT_DELAY_MS = 250

export function createComposerDraftAutosave(
  options: ComposerDraftAutosaveOptions,
): ComposerDraftAutosave {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS
  let timer: ReturnType<typeof setTimeout> | null = null

  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function schedule(): void {
    const threadId = options.getActiveThreadId()
    if (!threadId) return
    cancel()
    timer = setTimeout(() => {
      timer = null
      if (options.getActiveThreadId() !== threadId) return
      options.save(threadId, options.getValue())
    }, delayMs)
  }

  return { schedule, cancel }
}
