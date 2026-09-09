import type {
  RuntimeContainmentTier,
  UnattendedRunBudgets,
  UnattendedRunState,
} from '@shared/types/unattended-run.ts'
import { getGuardedYoloState, setGuardedYoloArmGuard } from './guarded-yolo.ts'
import { beginDeferralMode, endDeferralMode } from './deferral-mode.ts'
import { runtimeContainmentTier } from './runtime-containment.ts'

/**
 * Session-only, thread-scoped ledger of unattended runs
 * (`docs/plans/thread-in-container.md`, `unattended-runs.md` Decision 5).
 *
 * An unattended run is its own concept, beside — never inside — Guarded YOLO.
 * Guarded YOLO is "I am watching, stop asking me"; an unattended run is "I am
 * not here, keep working safely". They answer different questions, carry
 * different audit vocabularies, and are mutually exclusive on a thread. What is
 * copied from `GuardedYoloRegistry` is its shape, not its storage: nothing is
 * read from or written to settings, so no migration, restart or default can
 * turn it on.
 *
 * Arming does two things at once, so a gate can never see one without the
 * other: it records the run (runtime and budgets), and it switches the thread
 * into deferral mode so whatever the contained-effect policy does not settle is
 * queued for review rather than shown to an empty room.
 */

interface UnattendedRunEntry {
  phase: 'armed' | 'active'
  runtimeId: string
  budgets: UnattendedRunBudgets
}

export interface UnattendedRunSpec {
  runtimeId: string
  budgets: UnattendedRunBudgets
}

export class UnattendedRunRegistry {
  private readonly entries = new Map<string, UnattendedRunEntry>()
  private readonly listeners = new Set<(threadId: string) => void>()

  arm(threadId: string, spec: UnattendedRunSpec): void {
    if (getGuardedYoloState(threadId).phase !== 'off') {
      throw new Error(
        `Thread "${threadId}" has Guarded YOLO ${getGuardedYoloState(threadId).phase}; an unattended run cannot be armed beside it`,
      )
    }
    if (!(spec.budgets.wallClockMs > 0) || !(spec.budgets.tokenCeiling > 0)) {
      throw new Error('An unattended run needs a positive wall-clock and token budget')
    }
    this.entries.set(threadId, { phase: 'armed', runtimeId: spec.runtimeId, budgets: spec.budgets })
    beginDeferralMode(threadId)
    this.emit(threadId)
  }

  /** Consume an armed grant at run start. The active grant persists for the thread. */
  activateForRun(threadId: string): boolean {
    const entry = this.entries.get(threadId)
    if (entry?.phase !== 'armed') return entry?.phase === 'active'
    this.entries.set(threadId, { ...entry, phase: 'active' })
    this.emit(threadId)
    return true
  }

  disarm(threadId: string): void {
    if (!this.entries.delete(threadId)) return
    endDeferralMode(threadId)
    this.emit(threadId)
  }

  isArmedOrActive(threadId: string): boolean {
    return this.entries.has(threadId)
  }

  isActive(threadId: string): boolean {
    return this.entries.get(threadId)?.phase === 'active'
  }

  state(threadId: string, containment: RuntimeContainmentTier): UnattendedRunState {
    const entry = this.entries.get(threadId)
    return {
      threadId,
      phase: entry?.phase ?? 'off',
      runtimeId: entry?.runtimeId ?? null,
      containment,
      budgets: entry?.budgets ?? null,
    }
  }

  onChanged(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  clear(): void {
    const armed = [...this.entries.keys()]
    this.entries.clear()
    for (const threadId of armed) {
      endDeferralMode(threadId)
      this.emit(threadId)
    }
  }

  private emit(threadId: string): void {
    for (const listener of this.listeners) listener(threadId)
  }
}

const unattendedRunRegistry = new UnattendedRunRegistry()

// The other half of the exclusion: Guarded YOLO consults this ledger before it
// arms, without importing it (which would be a cycle).
setGuardedYoloArmGuard((threadId) =>
  unattendedRunRegistry.isArmedOrActive(threadId)
    ? `Thread "${threadId}" is armed for an unattended run; Guarded YOLO cannot be armed beside it`
    : null,
)

export function armUnattendedRun(threadId: string, spec: UnattendedRunSpec): void {
  unattendedRunRegistry.arm(threadId, spec)
}

export function activateUnattendedRunForRun(threadId: string): boolean {
  return unattendedRunRegistry.activateForRun(threadId)
}

export function disarmUnattendedRun(threadId: string): void {
  unattendedRunRegistry.disarm(threadId)
}

export function isUnattendedRunActive(threadId: string): boolean {
  return unattendedRunRegistry.isActive(threadId)
}

export function getUnattendedRunState(threadId: string): UnattendedRunState {
  return unattendedRunRegistry.state(threadId, runtimeContainmentTier())
}

export function onUnattendedRunChanged(listener: (threadId: string) => void): () => void {
  return unattendedRunRegistry.onChanged(listener)
}

/**
 * The one question the shell gate asks: may this run act on contained effects
 * without asking? Both facts are required — an armed run on the desktop tier is
 * *not* offered the container rules, and a container runtime without an armed
 * run keeps prompting (and therefore deferring nothing) exactly as today.
 */
export function currentRunIsUnattendedContainer(threadId: string | null): boolean {
  return (
    threadId !== null &&
    unattendedRunRegistry.isActive(threadId) &&
    runtimeContainmentTier() === 'container'
  )
}

/** Test seam: drop every entry so one spec cannot leak into the next. */
export function clearUnattendedRunsForTests(): void {
  unattendedRunRegistry.clear()
}
