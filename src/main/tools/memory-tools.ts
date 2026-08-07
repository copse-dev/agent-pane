import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  addKnowledgeNote,
  loadKnowledgeNotes,
  searchKnowledgeNotes,
  updateKnowledgeNote,
  type KnowledgeNote,
} from '../services/storage/knowledge-store.ts'

/**
 * Experimental OKF memories feature. `remember`/`recall` persist durable project
 * knowledge as OKF markdown notes. Memories are now the `Memory` type in the
 * shared knowledge store (issue #645) rather than a bespoke `~/.copse/memories`
 * store. The feature is gated by the `copse.okf-memories` first-party plugin
 * (`packages/agent/src/plugins/okf-memories-plugin.ts`), which the host reads to
 * register these tools and append the memory system-prompt block.
 */

/** Knowledge-note type used for memories. */
export const MEMORY_TYPE = 'Memory'

function formatMemory(note: KnowledgeNote): string {
  const tags = note.tags.length ? ` [${note.tags.join(', ')}]` : ''
  const when = note.updatedAt ? ` — ${note.updatedAt}` : ''
  return `## ${note.title}${tags}${when}\n\n${note.body}`
}

export const rememberTool = defineTool({
  name: 'remember',
  description:
    'Persist a durable memory for this project as an Open Knowledge Format (OKF) markdown note. Use it for facts worth recalling in future sessions: project conventions, decisions, gotchas, environment or setup details. Re-using an existing title updates that memory instead of duplicating it.',
  parameters: z.object({
    title: z
      .string()
      .describe('Short, unique title. Reuse a title to update that memory instead of adding one.'),
    content: z.string().describe('The memory body as markdown.'),
    tags: z.array(z.string()).optional().describe('Optional tags to aid later retrieval.'),
  }),
  execute({ title, content, tags }) {
    const cleanTitle = title.trim()
    const existing = loadKnowledgeNotes(MEMORY_TYPE).find((note) => note.title === cleanTitle)
    const note = existing
      ? (updateKnowledgeNote(existing.id, { body: content, tags: tags ?? existing.tags }) ??
        existing)
      : addKnowledgeNote({ type: MEMORY_TYPE, title: cleanTitle, body: content, tags })
    return `Saved memory "${note.title}" to ${note.file}`
  },
})

export const recallTool = defineTool({
  name: 'recall',
  description:
    'Recall previously stored project memories (OKF notes). Optionally filter with a query matched against titles, tags, and bodies; omit it to list every memory. Returns the matching memories as markdown.',
  parameters: z.object({
    query: z
      .string()
      .optional()
      .describe('Optional search terms — all must match. Omit to list every memory.'),
  }),
  execute({ query }) {
    const trimmed = query?.trim() ?? ''
    const memories = trimmed
      ? searchKnowledgeNotes(trimmed, MEMORY_TYPE)
      : loadKnowledgeNotes(MEMORY_TYPE)
    if (memories.length === 0) {
      return trimmed
        ? `No memories match "${trimmed}".`
        : 'No memories stored yet for this project. Use the remember tool to add one.'
    }
    const header = `Found ${String(memories.length)} ${memories.length === 1 ? 'memory' : 'memories'}:`
    return [header, ...memories.map(formatMemory)].join('\n\n')
  },
})
