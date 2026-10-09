import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../safe-json.ts'

/** Knowledge-note type used for roadmap items. */
export const ROADMAP_TYPE = 'Roadmap'

/**
 * Roadmap items keep the full prompt in the note body; the title is a derived
 * preview of it. Shared with the Roadmap pane's create/update path so both
 * surfaces produce identically-shaped notes.
 */
export function roadmapTitleFromPrompt(prompt: string): string {
  return prompt.slice(0, 80)
}

/**
 * Where a roadmap item sits relative to in-flight work. `ready` means nothing
 * blocks it; `blocked` / `conflicts` are set once starting it now would collide
 * with an open PR. `done` and `archived` are terminal.
 */
export const ROADMAP_STATUSES = ['ready', 'blocked', 'conflicts', 'done', 'archived'] as const

export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number]

const threadHistorySchema = z.array(z.string().min(1).max(128))

/** Latest attempt first, including legacy notes that only have a `thread` field. */
export function roadmapThreadIds(fields: Readonly<Record<string, string>>): string[] {
  const history = fields['threadHistory']
  const previous = history ? safeJsonParse(history, decodeWithSchema(threadHistorySchema)) : null
  return [...new Set([...(fields['thread'] ? [fields['thread']] : []), ...(previous ?? [])])]
}
