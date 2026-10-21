import type { Thread } from '@shared/types/thread.ts'

/** Fields changed by transcript reduction, shared by persistence and attachment. */
export const TRANSCRIPT_META_KEYS = [
  'status',
  'usage',
  'updatedAt',
  'todos',
  'contextTrims',
  'contextSnapshot',
  'resolvedModel',
  'model',
  'automation',
  'reviewReport',
  'worktreeChoice',
  'gitBranch',
  'worktree',
  'deferredWorktree',
] as const satisfies readonly (keyof Thread)[]

export type TranscriptMeta = Pick<Thread, (typeof TRANSCRIPT_META_KEYS)[number]>

export function transcriptMeta(thread: Thread): TranscriptMeta {
  const meta: TranscriptMeta = {
    status: thread.status,
    usage: thread.usage,
    updatedAt: thread.updatedAt,
  }
  for (const key of TRANSCRIPT_META_KEYS) Object.assign(meta, { [key]: thread[key] })
  return meta
}

/** Only changed fields: an unrelated window edit must not be overwritten. */
export function transcriptMetaPatch(
  before: TranscriptMeta,
  after: TranscriptMeta,
): Partial<TranscriptMeta> {
  const patch: Partial<TranscriptMeta> = {}
  for (const key of TRANSCRIPT_META_KEYS) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      Object.assign(patch, { [key]: after[key] })
    }
  }
  return patch
}
