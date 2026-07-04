import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  addKnowledgeNote,
  getKnowledgeNote,
  loadKnowledgeNotes,
  setKnowledgeNoteStatus,
  type KnowledgeNote,
} from '../services/storage/knowledge-store.ts'

/**
 * Experimental roadmap-plans feature (issue #556). A roadmap is a backlog of
 * future-work prompts to run over a longer time horizon than the current change.
 *
 * Roadmap items are now stored as the `Roadmap` type in the shared knowledge
 * store (issue #645) rather than a bespoke `items.json`: each item is an OKF
 * markdown note whose body is the prompt, with the lifecycle `status` in
 * frontmatter and any waiting-on context in a `notes` field. The tool surface and
 * the `roadmapPlansEnabled` experimental flag are unchanged. Registered only when
 * the flag is on (`registry-bootstrap.ts`).
 */
export const ROADMAP_PLANS_ENABLED_SETTING = 'roadmapPlansEnabled'

/** Knowledge-note type used for roadmap items. */
const ROADMAP_TYPE = 'Roadmap'

/**
 * Where a roadmap item sits relative to in-flight work. `ready` means nothing
 * blocks it; `blocked` / `conflicts` are set once starting it now would collide
 * with an open PR. `done` and `archived` are terminal.
 */
export const ROADMAP_STATUSES = ['ready', 'blocked', 'conflicts', 'done', 'archived'] as const

export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number]

function formatItem(note: KnowledgeNote): string {
  const notes = note.fields['notes'] ? `\n  notes: ${note.fields['notes']}` : ''
  return `- [${note.id}] (${note.status ?? 'ready'}) ${note.body}${notes}`
}

export const roadmapPlanTool = defineTool({
  name: 'roadmap_plan',
  description:
    'Manage the project roadmap: a backlog of future-work prompts to run over a longer time horizon than the current change. Use `add` to record a prompt to do later, `list` to review the backlog, and `set_status` to mark an item ready/blocked/conflicts/done/archived (e.g. blocked while a related PR is still open). The roadmap persists per project across sessions.',
  parameters: z.object({
    action: z
      .enum(['add', 'list', 'set_status'])
      .describe('add a new item, list the backlog, or update an item status'),
    prompt: z.string().optional().describe('For action=add: the future-work prompt to record.'),
    notes: z
      .string()
      .optional()
      .describe('For action=add: optional context, e.g. which PR this waits on.'),
    id: z.string().optional().describe('For action=set_status: the item id from `list`.'),
    status: z.enum(ROADMAP_STATUSES).optional().describe('For action=set_status: the new status.'),
  }),
  execute({ action, prompt, notes, id, status }) {
    if (action === 'add') {
      const trimmed = prompt?.trim()
      if (!trimmed) return 'roadmap_plan add requires a non-empty prompt.'
      const note = addKnowledgeNote({
        type: ROADMAP_TYPE,
        title: trimmed.slice(0, 80),
        body: trimmed,
        status: 'ready',
        fields: notes?.trim() ? { notes: notes.trim() } : {},
      })
      return `Added roadmap item ${note.id}.\n${formatItem(note)}`
    }
    if (action === 'set_status') {
      if (!id) return 'roadmap_plan set_status requires an item id.'
      if (!status) return 'roadmap_plan set_status requires a status.'
      const existing = getKnowledgeNote(id)
      if (!existing || existing.type !== ROADMAP_TYPE) {
        return `No roadmap item with id "${id}".`
      }
      const updated = setKnowledgeNoteStatus(id, status)
      return updated
        ? `Updated ${updated.id} → ${updated.status ?? status}.`
        : `No roadmap item with id "${id}".`
    }
    const items = loadKnowledgeNotes(ROADMAP_TYPE)
    if (items.length === 0) {
      return 'The roadmap is empty. Use roadmap_plan add to record future work.'
    }
    const header = `Roadmap (${String(items.length)} item${items.length === 1 ? '' : 's'}):`
    return [header, ...items.map(formatItem)].join('\n')
  },
})
