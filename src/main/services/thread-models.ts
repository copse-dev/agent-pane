import { AsyncLocalStorage } from 'node:async_hooks'
import { activateGuardedYoloForRun, finishGuardedYoloRun } from './security/guarded-yolo.ts'

// Tracks which LLM models actually ran in each thread so `git_commit` can credit
// them in the Copse attribution trailer. Populated from usage chunks during a
// run (the same signal the renderer uses to build `ThreadUsage.byModel`), and
// read back when committing. This lives in main because the agent loop and tools
// run here, while the reactive store — and its `byModel` map — lives in the
// renderer and isn't reachable from a tool's `execute`.

const modelsByThread = new Map<string, Set<string>>()

interface ActiveRunIdentity {
  readonly threadId: string
  model: string | null
}

const activeRunStorage = new AsyncLocalStorage<ActiveRunIdentity>()

/** Scope the active thread/model identity to one complete asynchronous run. */
export function runWithActiveRunIdentity<T>(threadId: string, fn: () => T): T {
  return activeRunStorage.run({ threadId, model: null }, fn)
}

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
export function setActiveRunThread(threadId: string): void {
  const active = activeRunStorage.getStore()
  if (!active) throw new Error('No active run identity context')
  if (active.threadId !== threadId) {
    throw new Error(`Active run identity belongs to "${active.threadId}", not "${threadId}"`)
  }
  activateGuardedYoloForRun(threadId)
}

/** Clear mutable model state only when this async context owns the thread. */
export function clearActiveRunThread(threadId: string): void {
  const active = activeRunStorage.getStore()
  if (active?.threadId === threadId) {
    finishGuardedYoloRun(threadId)
    active.model = null
  }
}

/** Thread whose run is currently executing tools, or null when idle. */
export function getActiveRunThread(): string | null {
  return activeRunStorage.getStore()?.threadId ?? null
}

/** Record the resolved model the active run is executing on (blank clears it). */
export function setActiveRunModel(model: string | null): void {
  const active = activeRunStorage.getStore()
  if (!active) throw new Error('No active run identity context')
  active.model = model && model.length > 0 ? model : null
}

/** The model the active run is executing on, or null when idle / unknown. */
export function getActiveRunModel(): string | null {
  return activeRunStorage.getStore()?.model ?? null
}

/** Drop tracked models for a thread (e.g. when it is deleted). */
export function clearThreadModels(threadId: string): void {
  modelsByThread.delete(threadId)
}
