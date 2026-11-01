import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { AGENT_ROLES } from '@copse/llm/agent-roles.ts'
import { defineTool } from '@shared/types'

export const runAgentParameters = z.object({
  task: z.string().trim().min(1).max(20_000).describe('The bounded task to complete.'),
  context: z
    .string()
    .max(80_000)
    .describe('All context the child needs. Parent conversation history is not forwarded.'),
  tools: z
    .array(z.string().trim().min(1))
    .max(64)
    .describe(
      'Exact Copse tool names. An empty list creates a reasoning-only worker. Unavailable or forbidden names reject the call.',
    ),
  task_type: z
    .enum(['match', ...AGENT_ROLES.map((role) => role.id)])
    .default('match')
    .describe('Settings task role, or match to infer it from the child task.'),
  intelligence: z
    .enum(['match', 'low', 'mid', 'top'])
    .default('match')
    .describe(
      'Required intellect band, or match to infer it. Explicit Settings model assignments win; mismatches are reported.',
    ),
})
export type RunAgentRequest = z.infer<typeof runAgentParameters>
type AgentRunner = (request: RunAgentRequest, signal: AbortSignal) => Promise<string>
const runners = new AsyncLocalStorage<AgentRunner>()

export function runWithAgentRunner<T>(runner: AgentRunner, run: () => Promise<T>): Promise<T> {
  return runners.run(runner, run)
}

export const runAgentTool = defineTool({
  name: 'run_agent',
  description:
    'Run a bounded subagent with an explicit task, context and tool allow-list. Choose a Settings task role and intelligence band without choosing a model. The child has no parent transcript and cannot delegate further. Selected tools retain normal permissions and read-only restrictions. Edits use this thread checkout; avoid overlapping writes. Waits for the report; Stop cancels the child. Shares the two-worker allowance per turn with named workers; two-minute deadline, no detached execution.',
  parameters: runAgentParameters,
  async execute(request, signal) {
    const runner = runners.getStore()
    if (!runner) throw new Error('run_agent requires a native parent turn.')
    return runner(request, signal)
  },
})
