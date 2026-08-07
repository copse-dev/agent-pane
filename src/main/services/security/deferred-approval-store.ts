import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFERRED_APPROVAL_SCHEMA_VERSION,
  deferredRequestKey,
  foldDeferredApprovals,
  parseDeferredApprovals,
  pendingDeferrals,
  type DeferredApproval,
  type DeferredApprovalInput,
  type DeferralStatus,
} from '@shared/threads/deferred-approval.ts'
import { redactSecrets } from '@shared/threads/decision-log.ts'
import { projectStoreDir } from '../storage/copse-paths.ts'
import { runSerialized } from '../storage/write-queue.ts'
import { getActiveProjectId } from '../workspace.ts'

/**
 * Durable queue of deferred approvals, beside the decision log under the same
 * project store root:
 *
 *   ~/.copse/workspace/<projectId>/deferred-approvals.jsonl
 *
 * Append-only, one entry per line, last write per id winning
 * ({@link foldDeferredApprovals}). Append-only because the queue is evidence as
 * much as state: "this was asked at 03:00 and approved at 09:00" is the record a
 * reviewer wants, and rewriting the pending line in place would erase it.
 *
 * Unlike the decision log, recording here is **not** best-effort. A deferral the
 * store fails to persist is an action that silently never happens: the agent was
 * told it was queued, and the user will never see it. So the writer surfaces its
 * failure to the caller, which refuses to defer and lets the normal prompt path
 * run instead.
 */

const QUEUE_FILE = 'deferred-approvals.jsonl'
const NO_PROJECT_BUCKET = '_global'

function queuePath(projectId: string): string {
  return join(projectStoreDir(projectId), QUEUE_FILE)
}

function queueKey(projectId: string): string {
  return `deferred-approvals:${projectId}`
}

function resolveProjectId(explicit?: string): string {
  return explicit ?? getActiveProjectId() ?? NO_PROJECT_BUCKET
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function appendEntry(projectId: string, entry: DeferredApproval): void {
  const path = queuePath(projectId)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(entry)}\n`)
}

/**
 * Queue one deferral, or return the existing entry when this exact request is
 * already pending. Deduplicating on {@link deferredRequestKey} keeps an agent
 * that retries a blocked action from filling the review list with copies of one
 * question — the same request gets the same queue entry and the same id back.
 */
export function deferApproval(
  input: DeferredApprovalInput,
  opts: { projectId?: string } = {},
): Promise<DeferredApproval> {
  const projectId = resolveProjectId(opts.projectId)
  return runSerialized(queueKey(projectId), () => {
    const existing = pendingDeferrals(parseDeferredApprovals(safeRead(queuePath(projectId))))
    const key = deferredRequestKey(input)
    const duplicate = existing.find((entry) => deferredRequestKey(entry) === key)
    if (duplicate) return duplicate

    const entry: DeferredApproval = {
      v: DEFERRED_APPROVAL_SCHEMA_VERSION,
      id: randomUUID(),
      at: Date.now(),
      status: 'pending',
      threadId: input.threadId,
      kind: input.kind,
      title: redactSecrets(input.title),
      subject: redactSecrets(input.subject),
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
      ...(input.reasons?.length ? { reasons: input.reasons.map(redactSecrets) } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
    }
    appendEntry(projectId, entry)
    return entry
  })
}

/** Every entry, newest state per id. */
export function readDeferredApprovals(projectId?: string): Promise<DeferredApproval[]> {
  const resolved = resolveProjectId(projectId)
  return runSerialized(queueKey(resolved), () =>
    foldDeferredApprovals(parseDeferredApprovals(safeRead(queuePath(resolved)))),
  )
}

/** Outstanding entries only, oldest first. Optionally narrowed to one thread. */
export function readPendingDeferrals(
  opts: { projectId?: string; threadId?: string } = {},
): Promise<DeferredApproval[]> {
  const resolved = resolveProjectId(opts.projectId)
  return runSerialized(queueKey(resolved), () => {
    const pending = pendingDeferrals(parseDeferredApprovals(safeRead(queuePath(resolved))))
    return opts.threadId ? pending.filter((entry) => entry.threadId === opts.threadId) : pending
  })
}

/**
 * Record a human's verdict. Returns the resolved entry, or null when the id is
 * unknown or already resolved — resolving twice must not mint a second record,
 * because a reviewer acting on a stale list would otherwise "approve" something
 * already rejected.
 */
export function resolveDeferral(
  id: string,
  status: Exclude<DeferralStatus, 'pending'>,
  opts: { projectId?: string; note?: string } = {},
): Promise<DeferredApproval | null> {
  const projectId = resolveProjectId(opts.projectId)
  return runSerialized(queueKey(projectId), () => {
    const current = foldDeferredApprovals(parseDeferredApprovals(safeRead(queuePath(projectId))))
    const entry = current.find((candidate) => candidate.id === id)
    if (!entry || entry.status !== 'pending') return null

    const resolvedEntry: DeferredApproval = {
      ...entry,
      status,
      resolvedAt: Date.now(),
      ...(opts.note ? { note: redactSecrets(opts.note) } : {}),
    }
    appendEntry(projectId, resolvedEntry)
    return resolvedEntry
  })
}
