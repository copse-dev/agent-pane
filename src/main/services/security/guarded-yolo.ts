import type { GuardedYoloContainment, GuardedYoloState } from '@shared/types/guarded-yolo.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/index.ts'

interface GuardedYoloEntry {
  phase: 'armed' | 'active'
}

/**
 * A reason arming must be refused for this thread, or null. Registered by the
 * unattended-run ledger so the two modes stay mutually exclusive without this
 * module importing it (`docs/plans/unattended-runs.md` Decision 5).
 */
type ArmGuard = (threadId: string) => string | null

let armGuard: ArmGuard = () => null

export function setGuardedYoloArmGuard(guard: ArmGuard): void {
  armGuard = guard
}

/**
 * Session-only, thread-scoped Guarded YOLO capability ledger. Nothing is read
 * from or written to settings, so migrations, fallbacks, and app restarts can
 * never enable the mode accidentally.
 */
export class GuardedYoloRegistry {
  private readonly entries = new Map<string, GuardedYoloEntry>()
  private readonly listeners = new Set<(threadId: string) => void>()

  arm(threadId: string): void {
    const refusal = armGuard(threadId)
    if (refusal !== null) throw new Error(refusal)
    this.entries.set(threadId, { phase: 'armed' })
    this.emit(threadId)
  }

  /** Consume an armed grant at run start. The active grant persists for the thread. */
  activateForRun(threadId: string): boolean {
    const entry = this.entries.get(threadId)
    if (entry?.phase !== 'armed') return entry?.phase === 'active'
    this.entries.set(threadId, { phase: 'active' })
    this.emit(threadId)
    return true
  }

  disable(threadId: string): void {
    if (!this.entries.delete(threadId)) return
    this.emit(threadId)
  }

  isActive(threadId: string): boolean {
    return this.entries.get(threadId)?.phase === 'active'
  }

  state(threadId: string, sandboxEnabled: boolean): GuardedYoloState {
    const entry = this.entries.get(threadId)
    const containment: GuardedYoloContainment = sandboxEnabled ? 'project-sandbox' : 'unsandboxed'
    return {
      threadId,
      phase: entry?.phase ?? 'off',
      containment,
      expiresAt: null,
    }
  }

  onChanged(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
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
