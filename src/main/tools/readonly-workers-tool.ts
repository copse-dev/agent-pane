import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { defineTool } from '@shared/types'
import type {
  ReadonlyWorkerRequest,
  ReadonlyWorkerResult,
} from '../services/agents/readonly-worker-batch.ts'

type WorkerRunner = (
  requests: readonly ReadonlyWorkerRequest[],
  signal: AbortSignal,
) => Promise<ReadonlyWorkerResult[]>
export const nativeWorkerRunners = new AsyncLocalStorage<WorkerRunner>()

export function runWithReadonlyWorkerRunner<T>(
  runner: WorkerRunner,
  run: () => Promise<T>,
): Promise<T> {
  return nativeWorkerRunners.run(runner, run)
}

export const readonlyWorkersTool = defineTool({
  name: 'run_readonly_workers',
  description:
    'Run one or two explicitly named custom agents on independent read-only tasks. Use exact agent names the user supplied; no automatic agent selection. Workers cannot write files, run shells or delegate further. The tool waits for attributable reports; Stop cancels owned work. At most two workers over this parent turn. Use run_isolated_workers for worktree isolation. Detached runs are unavailable.',
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
    if (!runner) return 'Error: read-only workers are unavailable in this context.'
    return JSON.stringify(await runner(workers, signal))
  },
})
