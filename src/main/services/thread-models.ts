// Tracks which LLM models actually ran in each thread so `git_commit` can credit
// them in the Copse attribution trailer. Populated from usage chunks during a
// run (the same signal the renderer uses to build `ThreadUsage.byModel`), and
// read back when committing. This lives in main because the agent loop and tools
// run here, while the reactive store — and its `byModel` map — lives in the
// renderer and isn't reachable from a tool's `execute`.

const modelsByThread = new Map<string, Set<string>>()

// The app runs one global model and serializes agent runs, so a single
// "current run" pointer is enough to tell a tool which thread it belongs to.
let activeRunThreadId: string | null = null

/** Record a model id observed for a thread (no-op for blank ids). */
export function recordThreadModel(threadId: string, model: string): void {
  if (!threadId || !model) return
  let used = modelsByThread.get(threadId)
  if (!used) {
    used = new Set<string>()
    modelsByThread.set(threadId, used)
  }
  used.add(model)
}

/** Distinct model ids seen for the thread, in first-seen order. */
export function getThreadModels(threadId: string): string[] {
  const used = modelsByThread.get(threadId)
  return used ? [...used] : []
}

/** Mark the thread whose agent run is currently executing tools. */
export function setActiveRunThread(threadId: string | null): void {
  activeRunThreadId = threadId
}

/** Clear the active-run pointer only if it still points at this thread. */
export function clearActiveRunThread(threadId: string): void {
  if (activeRunThreadId === threadId) activeRunThreadId = null
}

/** Thread whose run is currently executing tools, or null when idle. */
export function getActiveRunThread(): string | null {
  return activeRunThreadId
}

/** Drop tracked models for a thread (e.g. when it is deleted). */
export function clearThreadModels(threadId: string): void {
  modelsByThread.delete(threadId)
}
