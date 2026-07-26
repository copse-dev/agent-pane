import type { GuardedYoloContainment, GuardedYoloState } from '@shared/types/guarded-yolo.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/index.ts'

interface GuardedYoloEntry {
  phase: 'armed' | 'active'
  expiresAt: number | null
  cancelExpiry: (() => void) | null
}

interface GuardedYoloRegistryOptions {
  now?: () => number
}

/**
 * Session-only, thread-scoped Guarded YOLO capability ledger. Nothing is read
 * from or written to settings, so migrations, fallbacks, and app restarts can
 * never enable the mode accidentally.
 */
export class GuardedYoloRegistry {
  private readonly entries = new Map<string, GuardedYoloEntry>()
  private readonly listeners = new Set<(threadId: string) => void>()
  private readonly now: () => number

  constructor(options: GuardedYoloRegistryOptions = {}) {
    this.now = options.now ?? Date.now
  }

  arm(threadId: string): void {
    this.clearEntry(threadId)
    this.entries.set(threadId, { phase: 'armed', expiresAt: null, cancelExpiry: null })
    this.emit(threadId)
  }

  /** Consume an armed grant at run start. The active grant persists for the thread. */
  activateForRun(threadId: string): boolean {
    const entry = this.currentEntry(threadId)
    if (entry?.phase !== 'armed') return entry?.phase === 'active'
    entry.cancelExpiry?.()
    this.entries.set(threadId, { phase: 'active', expiresAt: null, cancelExpiry: null })
    this.emit(threadId)
    return true
  }

  /** No-op: once active, YOLO stays active for the thread until the user disables it. */
  finishRun(_threadId: string): void {
    // Previously deleted the entry. Now a no-op so the active state persists across runs.
  }

  disable(threadId: string): void {
    if (!this.entries.has(threadId)) return
    this.clearEntry(threadId)
    this.emit(threadId)
  }

  isActive(threadId: string): boolean {
    return this.currentEntry(threadId)?.phase === 'active'
  }

  state(threadId: string, sandboxEnabled: boolean): GuardedYoloState {
    const entry = this.currentEntry(threadId)
    const containment: GuardedYoloContainment = sandboxEnabled ? 'project-sandbox' : 'unsandboxed'
    return {
      threadId,
      phase: entry?.phase ?? 'off',
      containment,
      expiresAt: entry?.expiresAt ?? null,
    }
  }

  onChanged(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private currentEntry(threadId: string): GuardedYoloEntry | null {
    const entry = this.entries.get(threadId)
    if (!entry) return null
    if (entry.phase === 'armed' && entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.clearEntry(threadId)
      this.emit(threadId)
      return null
    }
    return entry
  }

  private clearEntry(threadId: string): void {
    this.entries.get(threadId)?.cancelExpiry?.()
    this.entries.delete(threadId)
  }

  private emit(threadId: string): void {
    for (const listener of this.listeners) listener(threadId)
  }
}

const guardedYoloRegistry = new GuardedYoloRegistry()

export function armGuardedYolo(threadId: string): void {
  guardedYoloRegistry.arm(threadId)
}

export function activateGuardedYoloForRun(threadId: string): boolean {
  return guardedYoloRegistry.activateForRun(threadId)
}

export function finishGuardedYoloRun(threadId: string): void {
  guardedYoloRegistry.finishRun(threadId)
}

export function disableGuardedYolo(threadId: string): void {
  guardedYoloRegistry.disable(threadId)
}

export function isGuardedYoloActive(threadId: string): boolean {
  return guardedYoloRegistry.isActive(threadId)
}

export function currentRunUsesGuardedYolo(threadId: string | null): boolean {
  return threadId !== null && isGuardedYoloActive(threadId)
}

export function getGuardedYoloState(threadId: string): GuardedYoloState {
  return guardedYoloRegistry.state(threadId, isProjectSandboxEnabled())
}

export function onGuardedYoloChanged(listener: (threadId: string) => void): () => void {
  return guardedYoloRegistry.onChanged(listener)
}
