import type { Thread } from '../types/thread.ts'

export const DEFAULT_AUTO_ARCHIVE_DAYS = 3
export const ARCHIVE_DAY_MS = 24 * 60 * 60 * 1000

export interface ThreadArchiveReview {
  threadId: string
  reason: string
}

export interface ThreadArchiveState {
  archived: Thread[]
  review: ThreadArchiveReview[]
}

export interface ThreadAutoArchived {
  projectId: string
  threadId: string
  title: string
  archivedAt: number
}

export type ThreadArchiveDecision = 'archive' | 'keep' | 'restore'

/** Missing/invalid settings never shorten the default inactivity window. */
export function autoArchiveDays(value: unknown): number {
  return value === 0
    ? 0
    : typeof value === 'number' && Number.isInteger(value) && value >= 3 && value <= 3650
      ? value
      : DEFAULT_AUTO_ARCHIVE_DAYS
}

export function threadIsInactive(
  thread: Omit<Thread, 'messages'>,
  now: number,
  days: number,
): boolean {
  return (
    days >= 3 &&
    thread.archivedAt == null &&
    thread.sideChat === undefined &&
    thread.automation === undefined &&
    thread.status !== 'running' &&
    thread.unreadAt == null &&
    !thread.draftPrompt?.trim() &&
    !thread.pendingMessages?.length &&
    Number.isFinite(thread.updatedAt) &&
    now - thread.updatedAt >= days * ARCHIVE_DAY_MS
  )
}
