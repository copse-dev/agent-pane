/**
 * Resolution verdicts for a roadmap item (issue #556 follow-up): has the work
 * described by the prompt been done? Judged on demand by
 * `src/main/services/roadmap-review.ts` using GitHub issue state, linked
 * issues, recent commits, and the small-tasks model — advisory only.
 */

export const ROADMAP_REVIEW_VERDICTS = ['resolved', 'likely', 'partial', 'open'] as const

export type RoadmapReviewVerdict = (typeof ROADMAP_REVIEW_VERDICTS)[number]

export function isRoadmapReviewVerdict(value: unknown): value is RoadmapReviewVerdict {
  return typeof value === 'string' && (ROADMAP_REVIEW_VERDICTS as readonly string[]).includes(value)
}

/** Extract the verdict from model output: the first review word in the first line. */
export function parseReviewVerdict(text: string): RoadmapReviewVerdict | null {
  const firstLine = (text.trim().split('\n')[0] ?? '').toLowerCase()
  const match = /\b(resolved|likely|partial|open)\b/.exec(firstLine)
  return match ? (match[1] as RoadmapReviewVerdict) : null
}

/**
 * True when an item needs a fresh resolution check — no verdict yet, or the
 * verdict belongs to a bulk pass the user has not acknowledged since.
 */
export function isReviewStale(
  fields: Record<string, string>,
  status: string | null | undefined,
  checkpoint: {
    lastAcknowledgedBulkRun: string | null
    pendingBulkRun: string | null
  },
): boolean {
  if (status === 'done' || status === 'archived') return false
  if (!isRoadmapReviewVerdict(fields['reviewVerdict'])) return true
  // A deep check uses the item's full commit lifetime and is invalidated when
  // prompt/issue edits clear the review fields. It does not need a bulk run id.
  if (fields['reviewDepth'] === 'deep') return false
  const bulkRun = fields['reviewBulkRun']
  if (!bulkRun) return true
  if (bulkRun === checkpoint.pendingBulkRun) return false
  if (bulkRun === checkpoint.lastAcknowledgedBulkRun) return false
  return true
}

/**
 * Turn stored review reasoning into markdown for rendering. Scalar frontmatter
 * collapses newlines on save, so persisted bullet lists use ` · ` separators.
 */
export function reviewDetailMarkdown(detail: string): string {
  const trimmed = detail.trim()
  if (!trimmed) return ''
  if (/^[-*] /m.test(trimmed) || trimmed.includes('\n')) return trimmed
  const parts = trimmed.split(/\s[•·]\s/)
  if (parts.length > 1) {
    return parts.map((part) => `- ${part.trim()}`).join('\n')
  }
  return trimmed
}
