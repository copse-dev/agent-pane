/**
 * Roadmap prompt complexity (issue #556 follow-up). Stamped on a roadmap item
 * when its prompt is saved — a one-shot judgement of how heavy the future work
 * looks, shown as a badge in the Roadmap pane. Classification lives in
 * `src/main/services/roadmap-complexity.ts` (small-tasks model only); this
 * module holds the pure vocabulary shared with the renderer.
 */

export const ROADMAP_COMPLEXITIES = ['low', 'medium', 'high'] as const

export type RoadmapComplexity = (typeof ROADMAP_COMPLEXITIES)[number]

export function isRoadmapComplexity(value: unknown): value is RoadmapComplexity {
  return typeof value === 'string' && ROADMAP_COMPLEXITIES.some((entry) => entry === value)
}

/**
 * Extract the classifier verdict from model output. Tolerant of chatty
 * replies: takes the first complexity word mentioned in the first line
 * ("Medium — touches two files" → medium); null when none is present.
 */
export function parseComplexityWord(text: string): RoadmapComplexity | null {
  const firstLine = (text.trim().split('\n')[0] ?? '').toLowerCase()
  const match = /\b(low|medium|high)\b/.exec(firstLine)
  const word = match?.[1]
  return isRoadmapComplexity(word) ? word : null
}
