import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  loadMemories,
  saveMemory,
  searchMemories,
  type OkfMemory,
} from '../services/okf-memory-store.ts'

function formatMemory(memory: OkfMemory): string {
  const tags = memory.tags.length ? ` [${memory.tags.join(', ')}]` : ''
  const when = memory.timestamp ? ` — ${memory.timestamp}` : ''
  return `## ${memory.title}${tags}${when}\n\n${memory.body}`
}

export const rememberTool = defineTool({
  name: 'remember',
  description:
    'Persist a durable memory for this project as an Open Knowledge Format (OKF) markdown note under ~/.copse/memories. Use it for facts worth recalling in future sessions: project conventions, decisions, gotchas, environment or setup details. Re-using an existing title updates that memory instead of duplicating it.',
  parameters: z.object({
    title: z
      .string()
      .describe('Short, unique title. Also the filename — reuse a title to update that memory.'),
    content: z
      .string()
      .describe('The memory body as markdown. Its first line becomes the OKF description.'),
    tags: z.array(z.string()).optional().describe('Optional tags to aid later retrieval.'),
  }),
  execute({ title, content, tags }) {
    const memory = saveMemory({ title, content, tags })
    return `Saved memory "${memory.title}" to ${memory.file}`
  },
})

export const recallTool = defineTool({
  name: 'recall',
  description:
    'Recall previously stored project memories (OKF notes under ~/.copse/memories). Optionally filter with a query matched against titles, tags, and bodies; omit it to list every memory. Returns the matching memories as markdown.',
  parameters: z.object({
    query: z
      .string()
      .optional()
      .describe('Optional search terms — all must match. Omit to list every memory.'),
  }),
  execute({ query }) {
    const trimmed = query?.trim() ?? ''
    const memories = trimmed ? searchMemories(trimmed) : loadMemories()
    if (memories.length === 0) {
      return trimmed
        ? `No memories match "${trimmed}".`
        : 'No memories stored yet for this project. Use the remember tool to add one.'
    }
    const header = `Found ${String(memories.length)} ${memories.length === 1 ? 'memory' : 'memories'}:`
    return [header, ...memories.map(formatMemory)].join('\n\n')
  },
})
