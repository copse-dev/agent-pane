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

/**
 * Roadmap item category — what kind of work the prompt represents. Stamped on
 * a roadmap item when its prompt is saved, the same one-shot background path as
 * complexity (`src/main/services/roadmap-category.ts`). The user can override
 * the verdict in the editor; a stored category survives notes/status edits and
 * is only re-classified when the prompt itself changes.
 *
 * - bug: fixing broken behavior — a crash, wrong output, or a regression.
 * - feature: new functionality or an enhancement to existing behavior.
 * - project: a multi-part initiative — a new subsystem, migration, or a goal
 *   that needs design and several distinct pieces of work before it lands.
 */
export const ROADMAP_CATEGORIES = ['bug', 'feature', 'project'] as const

export type RoadmapCategory = (typeof ROADMAP_CATEGORIES)[number]

export function isRoadmapCategory(value: unknown): value is RoadmapCategory {
  return typeof value === 'string' && ROADMAP_CATEGORIES.some((entry) => entry === value)
}

/** Human label for a category, used in the accordion header and filter list. */
export function roadmapCategoryLabel(category: RoadmapCategory): string {
  switch (category) {
    case 'bug':
      return 'Bugs'
    case 'feature':
      return 'Features'
    case 'project':
      return 'Projects'
  }
}

/**
 * Extract the category verdict from model output, tolerant of chatty replies.
 * Takes the first category word on the first line ("feature — adds a control"
 * → feature); null when none is present.
 */
export function parseCategoryWord(text: string): RoadmapCategory | null {
  const firstLine = (text.trim().split('\n')[0] ?? '').toLowerCase()
  const match = /\b(bug|feature|project)\b/.exec(firstLine)
  const word = match?.[1]
  return isRoadmapCategory(word) ? word : null
}
