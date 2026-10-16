import { GITHUB_WRITE_TOOLS } from '../security/permission-policy.ts'
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
export interface OpenAiHostTools {
  definitions: OpenAiFunctionTool[]
  validate(name: string, args: unknown): void
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
        .filter((tool) => READ_TOOLS.has(tool.name) || GITHUB_WRITE_TOOLS.has(tool.name))
        .map((tool) => ({
          type: 'function',
          name: tool.name,
          description: GITHUB_WRITE_TOOLS.has(tool.name)
            ? `${tool.description} The host queues this action until the turn finishes and exported changes are imported, then uses its normal approval flow. A queued response does not mean the action succeeded. Export and finish the turn; do not poll for completion.`
            : tool.description,
          parameters: tool.inputSchema,
        }))
    : []
  return {
    definitions,
    validate: (name, args): void => {
      registry.validateArgs(name, args)
    },
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
              const { result } = await registry.executeNormalized(name, args, signal)
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
