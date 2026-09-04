/**
 * Deferred approvals: the queue behind `docs/plans/deferred-approvals.md` D1.
 *
 * A gate that would open a modal has three outcomes once a run is unattended:
 * allow, deny, or **defer** — refuse for now, record the request with everything
 * a human needs to judge it later, and tell the agent to carry on with other
 * work. Nobody is watching, so a blocking prompt would hold the whole run
 * hostage until someone came back.
 *
 * Two invariants this module exists to keep (plan Decisions 3 and 4):
 *
 * 1. **A deferral is never mistakable for success.** The agent is told through a
 *    thrown {@link DeferredApprovalError}, never a falsy return that reads like
 *    a plain user rejection, and never a resolved value that reads like "done".
 *    The action did not run and will not run until a human says so.
 * 2. **The record outlives the run.** Review usually happens later, so the queue
 *    entry carries what was asked, when, the exact subject, the reasons, and
 *    where in the transcript it happened — enough to judge without replaying the
 *    conversation.
 *
 * Pure and Node-free: the store, the renderer, and unit tests share one
 * definition of the record and one definition of the wording.
 */

import { isPromptCause, type PromptCause } from './prompt-cause.ts'

/** Bump when the queue-entry shape changes in a backwards-incompatible way. */
export const DEFERRED_APPROVAL_SCHEMA_VERSION = 1

/**
 * Where a deferral has got to. `pending` until a human resolves it; the two
 * terminal states record what they decided, not whether the replay then
 * succeeded — that is the replay's own business (plan Decision 5).
 */
export type DeferralStatus = 'pending' | 'approved' | 'rejected'

export interface DeferredApproval {
  v: number
  /** Opaque unique id, assigned by the writer. */
  id: string
  /** Epoch ms the request was deferred. */
  at: number
  /** Thread the run belonged to; the queue is thread-owned. */
  threadId: string
  /** Turn the request came from, when known — the transcript position. */
  turnId?: string
  /** The gate's own kind: `shell` | `mcp` | `web` | … (matches the decision log). */
  kind: string
  /** Prompt title, as the user would have seen it. */
  title: string
  /** Secret-free subject: a tool name, an origin, or the shell placeholder. */
  subject: string
  /** Why the gate interrupted; drives the same report as the decision log. */
  cause?: PromptCause
  /** Redacted free-text detail of this specific request. */
  reasons?: string[]
  /** Scope the request applied at, e.g. `sandbox` | `external`. */
  scope?: string
  status: DeferralStatus
  /** Epoch ms a human resolved it. */
  resolvedAt?: number
  /** A note the rejecting human left; surfaced to the agent on its next turn. */
  note?: string
}

/** Fields a caller supplies; the writer adds `v`/`id`/`at`/`status`. */
export type DeferredApprovalInput = Omit<
  DeferredApproval,
  'v' | 'id' | 'at' | 'status' | 'resolvedAt' | 'note'
>

/**
 * Identity of the *request*, independent of when it happened. Two asks for the
 * same thing collapse onto one queue entry, so an agent that retries a blocked
 * action cannot flood the review list (plan D3's repeat-request problem, handled
 * here at the source rather than by steering the model).
 */
export function deferredRequestKey(input: DeferredApprovalInput): string {
  return JSON.stringify({
    threadId: input.threadId,
    kind: input.kind,
    subject: input.subject,
    scope: input.scope ?? '',
    cause: input.cause ?? '',
    reasons: input.reasons ?? [],
  })
}

/**
 * What the agent is told. The wording is load-bearing, so it lives here with a
 * test rather than being retyped at call sites: it has to read as "blocked, go
 * do something else", never as failure-worth-retrying (which burns the run on a
 * loop) and never as success (which would let the model report work it did not
 * do).
 */
export function deferredApprovalMessage(input: {
  title: string
  reasons?: string[] | undefined
}): string {
  const detail = input.reasons?.length ? ` (${input.reasons.join('; ')})` : ''
  return (
    `Queued for review, not run: ${input.title}${detail}. ` +
    'Nobody is available to approve this right now, so it has been added to a ' +
    'review queue for the user. This action has NOT run and will not run unless ' +
    'they approve it. Do not retry it or work around it — continue with the ' +
    'other parts of the task that do not depend on it, and say at the end what ' +
    'is still waiting on approval.'
  )
}

/**
 * Thrown in place of opening a modal. An error (rather than a falsy response)
 * because every existing gate caller treats `approved === false` as "the user
 * said no" and moves on quietly — which would silently drop the request instead
 * of queueing it. Throwing makes the deferral impossible to swallow by accident.
 */
export class DeferredApprovalError extends Error {
  readonly deferralId: string

  constructor(deferralId: string, message: string) {
    super(message)
    this.name = 'DeferredApprovalError'
    this.deferralId = deferralId
  }
}

export function isDeferredApprovalError(value: unknown): value is DeferredApprovalError {
  return value instanceof DeferredApprovalError
}

const STATUSES: ReadonlySet<string> = new Set(['pending', 'approved', 'rejected'])

function isStatus(value: unknown): value is DeferralStatus {
  return typeof value === 'string' && STATUSES.has(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isDeferredApproval(value: unknown): value is DeferredApproval {
  if (!isRecord(value)) return false
  const { v, id, at, threadId, kind, title, subject, status } = value
  const { turnId, cause, reasons, scope, resolvedAt, note } = value
  return (
    v === DEFERRED_APPROVAL_SCHEMA_VERSION &&
    typeof id === 'string' &&
    id.length > 0 &&
    typeof at === 'number' &&
    Number.isSafeInteger(at) &&
    at >= 0 &&
    typeof threadId === 'string' &&
    typeof kind === 'string' &&
    typeof title === 'string' &&
    typeof subject === 'string' &&
    isStatus(status) &&
    isOptionalString(turnId) &&
    (cause === undefined || isPromptCause(cause)) &&
    (reasons === undefined ||
      (Array.isArray(reasons) && reasons.every((r) => typeof r === 'string'))) &&
    isOptionalString(scope) &&
    (resolvedAt === undefined || typeof resolvedAt === 'number') &&
    isOptionalString(note)
  )
}

/** Parse a queue file body, skipping blank and malformed lines. */
export function parseDeferredApprovals(raw: string): DeferredApproval[] {
  const out: DeferredApproval[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (isDeferredApproval(parsed)) out.push(parsed)
  }
  return out
}

export function serializeDeferredApprovals(entries: readonly DeferredApproval[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : '')
}

/**
 * Collapse the log into current state: last write per id wins, so a resolution
 * supersedes the original pending line without rewriting history.
 */
export function foldDeferredApprovals(entries: readonly DeferredApproval[]): DeferredApproval[] {
  const byId = new Map<string, DeferredApproval>()
  for (const entry of entries) byId.set(entry.id, entry)
  return [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}

export function pendingDeferrals(entries: readonly DeferredApproval[]): DeferredApproval[] {
  return foldDeferredApprovals(entries).filter((entry) => entry.status === 'pending')
}
