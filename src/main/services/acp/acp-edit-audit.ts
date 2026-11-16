import type { GitChangeStatus } from '@shared/types/git.ts'

/** A file that changed during an ACP turn without passing the diff queue. */
export interface BypassedWrite {
  path: string
  status: GitChangeStatus
}

const STATUS_WORDS: Record<GitChangeStatus, string> = {
  untracked: 'new, untracked',
  added: 'new, staged',
  modified: 'edited',
  renamed: 'renamed',
  deleted: 'deleted',
}

/**
 * Past this many files the audit names them without asking git about each: a
 * turn that generated thousands of files should not hash all of them.
 */
export const MAX_AUDITED_GIT_STATE_FILES = 200

/**
 * Paths whose content git can be asked about: a deleted file has none on disk.
 * Null when there are too many to ask about.
 */
export function auditablePaths(writes: readonly BypassedWrite[]): string[] | null {
  const paths = writes.filter((write) => write.status !== 'deleted').map((write) => write.path)
  return paths.length > MAX_AUDITED_GIT_STATE_FILES ? null : paths
}

function describe(write: BypassedWrite, missing: ReadonlySet<string> | null): string {
  const status = STATUS_WORDS[write.status]
  if (write.status === 'deleted' || missing === null) return `- ${write.path} (${status})`
  if (missing.has(write.path)) {
    return `- ${write.path} (${status}): this version is in no commit, so the file on disk is the only copy`
  }
  return `- ${write.path} (${status}): git already has this exact content`
}

/**
 * The text of the edit-audit card (#591), with each file's git state (#4006):
 * the user, and the agent if it reads the card, can tell a scratch file from
 * the only copy of the work under review before agreeing to delete it.
 * `missing` is null when git could not say, and the list then names the files
 * without claiming anything about them.
 */
export function formatBypassedWriteAudit(
  writes: readonly BypassedWrite[],
  missing: ReadonlySet<string> | null,
): string {
  const onlyCopies = writes.some(
    (write) => write.status !== 'deleted' && missing?.has(write.path) === true,
  )
  return [
    'Warning: these files changed on disk during the agent’s turn outside the approved ' +
      "sphere — no diff was reviewed for them. The write came from the agent's own " +
      'tools (e.g. its shell) or from something else entirely:',
    ...writes.map((write) => describe(write, missing)),
    ...(onlyCopies
      ? ['A file that is the only copy is live work, not a duplicate: deleting it loses it.']
      : []),
    'Review them (e.g. git diff) before relying on the workspace state.',
  ].join('\n')
}
