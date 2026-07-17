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

// The resolved model (post-fallback) the active run is actually executing on.
// This is the "model actually running" the Cursor hook agent-session payloads
// report (B4); distinct from `modelsByThread`, which is the *set* of models a
// thread ever used (for commit attribution).
let activeRunModel: string | null = null

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
  if (activeRunThreadId === threadId) {
    activeRunThreadId = null
    // No active run ⇒ no active model. The app serializes runs, so clearing the
    // model here keeps the two pointers consistent without touching every finally.
    activeRunModel = null
  }
}

/** Thread whose run is currently executing tools, or null when idle. */
export function getActiveRunThread(): string | null {
  return activeRunThreadId
}

/** Record the resolved model the active run is executing on (blank clears it). */
export function setActiveRunModel(model: string | null): void {
  activeRunModel = model && model.length > 0 ? model : null
}

/** The model the active run is executing on, or null when idle / unknown. */
export function getActiveRunModel(): string | null {
  return activeRunModel
}

/** Drop tracked models for a thread (e.g. when it is deleted). */
export function clearThreadModels(threadId: string): void {
  modelsByThread.delete(threadId)
}
