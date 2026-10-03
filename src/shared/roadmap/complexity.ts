/**
 * Roadmap prompt complexity (issue #556 follow-up). Stamped on a roadmap item
 * when its prompt is saved — a one-shot judgement of how heavy the future work
 * looks, shown as a badge in the Roadmap pane. Classification lives in
 * `src/main/services/roadmap-complexity.ts`; this module holds the pure
 * vocabulary shared with the renderer.
 */

import { memberOf } from '@shared/member-of.ts'

export const ROADMAP_COMPLEXITIES = ['low', 'medium', 'high'] as const

export type RoadmapComplexity = (typeof ROADMAP_COMPLEXITIES)[number]

export const isRoadmapComplexity = memberOf(ROADMAP_COMPLEXITIES)

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

export const isRoadmapCategory = memberOf(ROADMAP_CATEGORIES)

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
