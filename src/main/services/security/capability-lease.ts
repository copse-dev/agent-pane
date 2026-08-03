import { randomUUID } from 'node:crypto'
import type { TurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import { parseShellComposition } from './command-routing.ts'

export const SHELL_REPLAY_LEASE_TTL_MS = 15 * 60_000
export const SHELL_REPLAY_LEASE_MAX_REPLAYS = 2
export const SHELL_REPLAY_LEASE_MAX_COMPANIONS = 8

export interface ShellReplayLeaseIdentity {
  projectId: string
  threadId: string
  turnTreeId: TurnTreeId
  executionRoot: string
  containment: 'project-sandbox' | 'external'
}

export interface ShellReplayLease {
  id: string
  identity: ShellReplayLeaseIdentity
  command: string
  expiresAt: number
  remainingReplays: number
  remainingCompanions: number
}

export type ShellReplayMatch =
  { matched: false } | { matched: true; leaseId: string; companionSegments: string[] }

interface ShellReplayLeaseStoreOptions {
  now?: () => number
  createId?: () => string
}

/**
 * Main-process, fail-closed leases for bounded shell command replays.
 *
 * Raw commands remain memory-only. Durable audit events refer to the opaque
 * lease id, never to the command or its arguments.
 */
export class ShellReplayLeaseStore {
  private readonly leases = new Map<string, ShellReplayLease>()
  private readonly now: () => number
  private readonly createId: () => string

  constructor(options: ShellReplayLeaseStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  issue(identity: ShellReplayLeaseIdentity, command: string): ShellReplayLease {
    this.prune()
    const lease: ShellReplayLease = {
      id: this.createId(),
      identity: { ...identity },
      command,
      expiresAt: this.now() + SHELL_REPLAY_LEASE_TTL_MS,
      remainingReplays: SHELL_REPLAY_LEASE_MAX_REPLAYS,
      remainingCompanions: SHELL_REPLAY_LEASE_MAX_COMPANIONS,
    }
    this.leases.set(lease.id, lease)
    return { ...lease, identity: { ...lease.identity } }
  }

  consume(
    identity: ShellReplayLeaseIdentity,
    command: string,
    allowsCompanion: (segment: string) => boolean,
  ): ShellReplayMatch {
    this.prune()
    for (const lease of this.leases.values()) {
      if (!sameIdentity(lease.identity, identity) || lease.remainingReplays <= 0) continue
      const companionSegments = matchingComposition(lease.command, command)
      if (
        companionSegments === null ||
        !companionSegments.every((segment) => allowsCompanion(segment))
      ) {
        continue
      }
      lease.remainingReplays--
      if (lease.remainingReplays === 0 && lease.remainingCompanions === 0) {
        this.leases.delete(lease.id)
      }
      return { matched: true, leaseId: lease.id, companionSegments }
    }
    return { matched: false }
  }

  consumeCompanion(identity: ShellReplayLeaseIdentity): string | null {
    this.prune()
    for (const lease of this.leases.values()) {
      if (!sameOwner(lease.identity, identity) || lease.remainingCompanions <= 0) continue
      lease.remainingCompanions--
      if (lease.remainingReplays === 0 && lease.remainingCompanions === 0) {
        this.leases.delete(lease.id)
      }
      return lease.id
    }
    return null
  }

  revoke(id: string): boolean {
    return this.leases.delete(id)
  }

  clear(): void {
    this.leases.clear()
  }

  private prune(): void {
    const now = this.now()
    for (const [id, lease] of this.leases) {
      if (
        lease.expiresAt <= now ||
        (lease.remainingReplays <= 0 && lease.remainingCompanions <= 0)
      ) {
        this.leases.delete(id)
      }
    }
  }
}

function sameIdentity(a: ShellReplayLeaseIdentity, b: ShellReplayLeaseIdentity): boolean {
  return sameOwner(a, b) && a.containment === b.containment
}

function sameOwner(a: ShellReplayLeaseIdentity, b: ShellReplayLeaseIdentity): boolean {
  return (
    a.projectId === b.projectId &&
    a.threadId === b.threadId &&
    a.turnTreeId === b.turnTreeId &&
    a.executionRoot === b.executionRoot
  )
}

/**
 * Select the sole constituent that needs approval. Every other constituent must
 * be independently authorized by ordinary policy.
 */
export function replayLeaseCore(
  command: string,
  allowsCompanion: (segment: string) => boolean,
): string | null {
  const composition = parseShellComposition(command)
  if (
    !composition ||
    composition.operators.some((operator) => operator === '||' || operator === '&')
  ) {
    return null
  }
  const coreIndexes = composition.segments.flatMap((segment, index) =>
    allowsCompanion(segment) ? [] : [index],
  )
  if (coreIndexes.length !== 1) return null
  const coreIndex = coreIndexes[0]
  if (coreIndex === undefined || composition.operators[coreIndex - 1] === '|') return null
  return composition.segments[coreIndex] ?? null
}

/**
 * Match a byte-identical leased constituent inside a conservative top-level
 * composition. The original command still executes unchanged; this function
 * only proves that every additional constituent has its own authorization.
 */
function matchingComposition(leased: string, candidate: string): string[] | null {
  if (candidate === leased) return []
  const composition = parseShellComposition(candidate)
  if (
    !composition ||
    composition.operators.some((operator) => operator === '||' || operator === '&')
  ) {
    return null
  }
  const leasedIndexes = composition.segments.flatMap((segment, index) =>
    segment === leased ? [index] : [],
  )
  if (leasedIndexes.length !== 1) return null
  const leasedIndex = leasedIndexes[0]
  if (leasedIndex === undefined || composition.operators[leasedIndex - 1] === '|') return null
  return composition.segments.filter((_segment, index) => index !== leasedIndex)
}

export const shellReplayLeaseStore = new ShellReplayLeaseStore()
