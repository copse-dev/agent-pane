import { activeRunStorage } from './active-run-identity.ts'
export { getActiveRunThread, runWithActiveRunIdentity } from './active-run-identity.ts'
import type { TurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import { activateGuardedYoloForRun } from './security/guarded-yolo.ts'

// Tracks which LLM models actually ran in each thread so `git_commit` can credit
// them in the Copse attribution trailer. Populated from usage chunks during a
// run (the same signal the renderer uses to build `ThreadUsage.byModel`), and
// read back when committing. This lives in main because the agent loop and tools
// run here, while the reactive store — and its `byModel` map — lives in the
// renderer and isn't reachable from a tool's `execute`.

const modelsByThread = new Map<string, Set<string>>()

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
    active.model = null
    active.turnTreeId = null
  }
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

/** Bind the human-originated turn-tree epoch to the active run. */
export function setActiveRunTurnTreeId(turnTreeId: TurnTreeId): void {
  const active = activeRunStorage.getStore()
  if (!active) throw new Error('No active run identity context')
  active.turnTreeId = turnTreeId
}

/** Human-originated turn-tree epoch for the active run, or null outside one. */
export function getActiveRunTurnTreeId(): TurnTreeId | null {
  return activeRunStorage.getStore()?.turnTreeId ?? null
}

/** Drop tracked models for a thread (e.g. when it is deleted). */
export function clearThreadModels(threadId: string): void {
  modelsByThread.delete(threadId)
}
