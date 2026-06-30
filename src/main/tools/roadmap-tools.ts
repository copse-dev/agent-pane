import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  addRoadmapItem,
  loadRoadmapItems,
  setRoadmapItemStatus,
  ROADMAP_STATUSES,
  type RoadmapItem,
} from '../services/roadmap-plans-store.ts'

function formatItem(item: RoadmapItem): string {
  const notes = item.notes ? `\n  notes: ${item.notes}` : ''
  return `- [${item.id}] (${item.status}) ${item.prompt}${notes}`
}

/**
 * Experimental roadmap-plans tool (issue #556). Lets the agent record prompts to
 * run later and track their status across sessions, so longer-horizon work is
 * captured without being started prematurely. Registered only when the
 * `roadmapPlansEnabled` experimental setting is on.
 */
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
    id: z.string().optional().describe('For action=set_status: the item id, e.g. "r3".'),
    status: z.enum(ROADMAP_STATUSES).optional().describe('For action=set_status: the new status.'),
  }),
  execute({ action, prompt, notes, id, status }) {
    if (action === 'add') {
      const trimmed = prompt?.trim()
      if (!trimmed) return 'roadmap_plan add requires a non-empty prompt.'
      const item = addRoadmapItem({ prompt: trimmed, notes })
      return `Added roadmap item ${item.id}.\n${formatItem(item)}`
    }
    if (action === 'set_status') {
      if (!id) return 'roadmap_plan set_status requires an item id.'
      if (!status) return 'roadmap_plan set_status requires a status.'
      const updated = setRoadmapItemStatus(id, status)
      return updated
        ? `Updated ${updated.id} → ${updated.status}.`
        : `No roadmap item with id "${id}".`
    }
    const items = loadRoadmapItems()
    if (items.length === 0) {
      return 'The roadmap is empty. Use roadmap_plan add to record future work.'
    }
    const header = `Roadmap (${String(items.length)} item${items.length === 1 ? '' : 's'}):`
    return [header, ...items.map(formatItem)].join('\n')
  },
})
