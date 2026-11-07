import { z } from 'zod'
import { defineTool } from '@shared/types'
import { nativeWorkerRunners } from './readonly-workers-tool.ts'

export const isolatedWorkersTool = defineTool({
  name: 'run_isolated_workers',
  description:
    'Run one or two explicitly named custom agents in separate owned writable Git worktrees. Use exact agent names the user supplied. Native file edits and preflight_worktree/approved prepare_worktree are available; shells, external tools, commits and further delegation are unavailable. Reports identify checkout paths and branches; integrate changes separately. Stop cancels owned work and retains edits safely. Shares the two-worker parent-turn allowance with run_readonly_workers, one attempt and two-minute deadlines. Local Git checkouts only; detached runs unavailable.',
  parameters: z.object({
    workers: z
      .array(
        z.object({
          agent: z
            .string()
            .min(1)
            .max(160)
            .describe('Exact custom agent name explicitly requested by the user'),
          prompt: z
            .string()
            .min(1)
            .max(20_000)
            .describe(
              'Independent task and all necessary context; the worker cannot see this conversation',
            ),
        }),
      )
      .min(1)
      .max(2),
  }),
  async execute({ workers }, signal) {
    const runner = nativeWorkerRunners.getStore()
    if (!runner) return 'Error: isolated workers are unavailable in this context.'
    return JSON.stringify(await runner(workers, signal))
  },
})
