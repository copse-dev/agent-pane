/**
 * Coverage verdicts for open GitHub issues against existing roadmap items
 * (import picker): does a backlog prompt already address this issue even
 * when it is not pinned? Judged on demand by
 * `src/main/services/roadmap-issue-coverage.ts` (small-tasks model, advisory);
 * this module holds the pure vocabulary and parser shared with the renderer.
 */

export const ROADMAP_COVERAGE_VERDICTS = ['likely', 'partial'] as const

export type RoadmapCoverageVerdict = (typeof ROADMAP_COVERAGE_VERDICTS)[number]

export function isRoadmapCoverageVerdict(value: unknown): value is RoadmapCoverageVerdict {
  return (
    typeof value === 'string' && (ROADMAP_COVERAGE_VERDICTS as readonly string[]).includes(value)
  )
}

/** One model-judged match: open issue → existing roadmap item. */
export interface RoadmapIssueCoverageMatch {
  issueNumber: number
  itemId: string
  itemTitle: string
  verdict: RoadmapCoverageVerdict
}

/**
 * Parse model output into coverage matches. Expected lines look like:
 *   #52 item-uuid likely
 *   41 abc-123 partial
 * Blank / commentary lines are ignored. Duplicate issue numbers keep the
 * strongest verdict (`likely` over `partial`) and the first item id for that
 * strength.
 */
export function parseCoverageMatches(
  text: string,
  knownItemIds: ReadonlySet<string>,
): Omit<RoadmapIssueCoverageMatch, 'itemTitle'>[] {
  const byIssue = new Map<number, { itemId: string; verdict: RoadmapCoverageVerdict }>()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('```')) continue
    const match = /^#?(\d+)\s+(\S+)\s+(likely|partial)\b/i.exec(line)
    if (!match?.[1] || !match[2] || !match[3]) continue
    const issueNumber = Number.parseInt(match[1], 10)
    if (!Number.isFinite(issueNumber) || issueNumber <= 0) continue
    const itemId = match[2]
    if (!knownItemIds.has(itemId)) continue
    const verdict = match[3].toLowerCase()
    if (!isRoadmapCoverageVerdict(verdict)) continue
    const existing = byIssue.get(issueNumber)
    if (!existing || (verdict === 'likely' && existing.verdict === 'partial')) {
      byIssue.set(issueNumber, { itemId, verdict })
    }
  }
  return [...byIssue.entries()].map(([issueNumber, { itemId, verdict }]) => ({
    issueNumber,
    itemId,
    verdict,
  }))
}
