import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getOrchestrationRunner } from '../services/orchestration-runner.ts'

/**
 * Experimental orchestration-pattern tool (the inverse of the advisor tool):
 * the chat model stays the orchestrator and delegates one bounded
 * implementation step at a time to a cheaper/faster worker model running as a
 * subagent with implementation tools. The result carries the worker's report
 * plus a working-tree snapshot so the orchestrator observes between steps.
 * Registered only when `orchestrationStrategyEnabled` is on.
 */
export const delegateStepTool = defineTool({
  name: 'delegate_step',
  description:
    'Delegate ONE bounded implementation step to a cheaper, faster worker model. The worker does not see this conversation — it sees only what you pass here, so include every file path, interface, convention, and constraint it needs. Keep steps small and independently verifiable. The result is the worker’s report plus a git status snapshot: review it (and git_diff when in doubt) before delegating the next step. You stay responsible for planning, reviewing each step’s output, and integration (commits stay yours).',
  parameters: z.object({
    step: z
      .string()
      .describe('The single implementation step to complete now, stated as a concrete deliverable'),
    context: z
      .string()
      .describe(
        'Everything the worker needs to do the step: relevant file paths, code conventions, interfaces to match, constraints. The worker cannot see the conversation.',
      ),
    expected_outcome: z
      .string()
      .optional()
      .describe('What done looks like: behavior to verify, tests or commands that should pass'),
  }),
  async execute({ step, context, expected_outcome }, signal) {
    const runner = getOrchestrationRunner()
    if (!runner) {
      return 'Error: the orchestration worker is not available in this context.'
    }
    return await runner({
      step,
      context,
      ...(expected_outcome !== undefined ? { expectedOutcome: expected_outcome } : {}),
      signal,
    })
  },
})
