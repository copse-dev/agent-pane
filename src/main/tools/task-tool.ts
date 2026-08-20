import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getCustomAgentRunner } from '../services/agents/custom-agent-runner.ts'

/**
 * Delegate to a user-authored subagent (docs/plans/custom-subagents.md).
 *
 * Registered once at boot and **withheld per turn**: `parentTools` only offers
 * it on a turn where the user invoked an agent with `/name`. The registry is a
 * process-wide singleton shared by every thread, so nothing about this tool may
 * be turn-specific at registration time — the turn's agent lives in the runner's
 * ALS context, and `subagent_type` is validated against it at execute time.
 *
 * `subagent_type` is a plain string rather than an enum for the same reason:
 * a schema built from one turn's agent would be wrong for a concurrent thread's.
 */
export const taskTool = defineTool({
  name: 'task',
  description:
    'Delegate this turn to the subagent the user invoked. The subagent runs with its own system prompt and tools, cannot see this conversation, and returns a written report. Pass everything it needs in `prompt` — file paths, constraints, what "done" looks like.',
  parameters: z.object({
    subagent_type: z.string().describe('Name of the agent the user invoked this turn'),
    prompt: z
      .string()
      .describe(
        'What the agent should do, stated as a self-contained task. It cannot see the conversation.',
      ),
  }),
  async execute({ subagent_type, prompt }, signal) {
    const runner = getCustomAgentRunner()
    if (!runner) {
      return 'Error: no agent was invoked for this turn, so there is nothing to delegate to. Answer directly instead.'
    }
    return await runner({ subagentType: subagent_type, prompt, signal })
  },
})
