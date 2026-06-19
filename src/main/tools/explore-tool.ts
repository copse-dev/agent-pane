import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { getExploreSubagentRunner } from '../services/explore-subagent-runner.ts'

export const exploreTool: ToolDefinition = {
  name: 'explore',
  description:
    'Explore the codebase by reading and searching files. Returns a concise summary instead of raw file contents. Use this instead of read_file or search tools.',
  parameters: z.object({
    query: z.string().describe('What to find or understand in the codebase'),
    paths: z.array(z.string()).optional().describe('Optional paths to focus exploration on'),
  }),
  async execute({ query, paths }, signal) {
    const runner = getExploreSubagentRunner()
    if (!runner) {
      return 'Error: explore subagent is not available in this context.'
    }
    const result = await runner({ query, paths, signal })
    return result.summary
  },
}
