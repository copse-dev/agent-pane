import {
  GUARDED_YOLO_ARM_TTL_MS,
  type GuardedYoloContainment,
  type GuardedYoloState,
} from '@shared/types/guarded-yolo.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/index.ts'

interface GuardedYoloEntry {
  phase: 'armed' | 'active'
  expiresAt: number | null
  cancelExpiry: (() => void) | null
}

interface GuardedYoloRegistryOptions {
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => () => void
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => {
    clearTimeout(timer)
  }
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
  private readonly schedule: (callback: () => void, delayMs: number) => () => void

  constructor(options: GuardedYoloRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? defaultSchedule
  }

  arm(threadId: string): void {
    this.clearEntry(threadId)
    const expiresAt = this.now() + GUARDED_YOLO_ARM_TTL_MS
    const cancelExpiry = this.schedule(() => {
      const current = this.entries.get(threadId)
      if (current?.phase !== 'armed' || current.expiresAt !== expiresAt) return
      this.entries.delete(threadId)
      this.emit(threadId)
    }, GUARDED_YOLO_ARM_TTL_MS)
    this.entries.set(threadId, { phase: 'armed', expiresAt, cancelExpiry })
    this.emit(threadId)
  }

  /** Consume an armed grant at run start. The active grant ends with that run. */
  activateForRun(threadId: string): boolean {
    const entry = this.currentEntry(threadId)
    if (entry?.phase !== 'armed') return entry?.phase === 'active'
    entry.cancelExpiry?.()
    this.entries.set(threadId, { phase: 'active', expiresAt: null, cancelExpiry: null })
    this.emit(threadId)
    return true
  }

  finishRun(threadId: string): void {
    if (this.entries.get(threadId)?.phase !== 'active') return
    this.entries.delete(threadId)
    this.emit(threadId)
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
