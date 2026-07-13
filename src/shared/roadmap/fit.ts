/**
 * Fit verdicts for a roadmap item against its pinned GitHub issue (issue #556
 * follow-up): would executing the prompt plausibly resolve the issue? Judged
 * on demand by `src/main/services/roadmap-fit-check.ts` (small-tasks model,
 * advisory only); this module holds the pure vocabulary shared with the
 * renderer's badge and result display.
 */

export const ROADMAP_FITS = ['likely', 'partial', 'unlikely'] as const

export type RoadmapFit = (typeof ROADMAP_FITS)[number]

export function isRoadmapFit(value: unknown): value is RoadmapFit {
  return typeof value === 'string' && (ROADMAP_FITS as readonly string[]).includes(value)
}

/**
 * Extract the verdict from model output: the first fit word in the first
 * line. The rest of the output is free-form reasoning shown to the user.
 */
export function parseFitVerdict(text: string): RoadmapFit | null {
  const firstLine = (text.trim().split('\n')[0] ?? '').toLowerCase()
  const match = /\b(likely|partial|unlikely)\b/.exec(firstLine)
  return match ? (match[1] as RoadmapFit) : null
}
