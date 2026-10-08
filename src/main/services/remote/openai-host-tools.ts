import { z } from 'zod'
import { READONLY_MODE_BLOCK_MESSAGE } from '@shared/tools/readonly-tools.ts'
import type { ToolRegistry } from '../tool-registry.ts'
import {
  getThreadExecutionContext,
  runWithThreadExecutionContext,
} from '../thread-execution-context.ts'
import { runWithActiveRunIdentity } from '../thread-models.ts'
import { runWithApprovalToolCallId } from '../approval-tool-call-context.ts'
import type { OpenAiFunctionTool, OpenAiFunctionResult } from './openai-agents-api.ts'

const READ_TOOLS = new Set([
  'gh_pr_list',
  'gh_pr_view',
  'gh_pr_files',
  'gh_run_list',
  'gh_run_view',
  'get_ci_status',
  'wait_for_ci_checks',
  'get_ci_failure_logs',
])
export const openAiPrRequestSchema = z
  .object({
    title: z.string().min(1).max(256),
    body: z.string().max(60_000),
    draft: z.boolean(),
  })
  .strict()
export interface OpenAiHostTools {
  definitions: OpenAiFunctionTool[]
  execute(
    name: string,
    args: unknown,
    callId: string,
    signal: AbortSignal,
  ): Promise<OpenAiFunctionResult>
}

/** Same registry and permission gate as ACP, with no local filesystem/shell exposure. */
export function createOpenAiHostTools(registry: ToolRegistry, threadId: string): OpenAiHostTools {
  const owner = getThreadExecutionContext()
  const definitions: OpenAiFunctionTool[] = owner
    ? registry
        .toMcpTools()
        .filter((tool) => READ_TOOLS.has(tool.name) || tool.name === 'gh_pr_create')
        .map((tool) => ({
          type: 'function',
          name: tool.name,
          description:
            tool.name === 'gh_pr_create'
              ? 'Queue a pull request for this thread. The host will ask for approval and push the entire current branch after this turn finishes and its changes are imported. This returns queued, not a PR URL. Export your changes and finish the turn; do not wait or poll for creation.'
              : tool.description,
          parameters:
            tool.name === 'gh_pr_create' ? z.toJSONSchema(openAiPrRequestSchema) : tool.inputSchema,
        }))
    : []
  return {
    definitions,
    async execute(name, args, callId, signal): Promise<OpenAiFunctionResult> {
      const context = getThreadExecutionContext()
      if (
        !owner ||
        !context ||
        context.projectId !== owner.projectId ||
        owner.threadId !== threadId ||
        context.threadId !== threadId ||
        !definitions.some((tool) => tool.name === name) ||
        !registry.has(name)
      )
        return { success: false, error: 'Host tool is unavailable for this thread.' }
      signal.throwIfAborted()
      return runWithActiveRunIdentity(threadId, () =>
        runWithThreadExecutionContext(context, () =>
          runWithApprovalToolCallId(callId, async () => {
            try {
              const { result } = await registry.executeNormalized(
                name,
                name === 'gh_pr_create' ? openAiPrRequestSchema.parse(args) : args,
                signal,
              )
              const failed =
                /^(Failed:|Error:|User rejected|Tool .* blocked)/.test(result) ||
                result.includes(READONLY_MODE_BLOCK_MESSAGE)
              return failed ? { success: false, error: result } : { success: true, output: result }
            } catch (error) {
              signal.throwIfAborted()
              return {
                success: false,
                error: error instanceof Error ? error.message : 'Host tool failed.',
              }
            }
          }),
        ),
      )
    },
  }
}
