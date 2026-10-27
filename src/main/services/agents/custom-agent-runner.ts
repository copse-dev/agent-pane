import { buildSkillsCatalogBlock } from '../skills/skill-prompt.ts'
import {
  createSkillActivationTurn,
  runWithSkillActivationTurn,
} from '../skills/skill-activation.ts'
import { runSubagent } from '@copse/agent/run-subagent.ts'
import { conversationTokenBudget } from '@copse/agent/trim-history.ts'
import { readFileLimitsForSubagent } from '@copse/agent/read-file-limits.ts'
import type {
  LLMMessage,
  LLMProvider,
  LLMTool,
  StreamChunk,
  ToolExecuteResult,
} from '@shared/types'
import type { AgentMetadata } from '@shared/types/agents.ts'
import type { ToolRegistry } from './../tool-registry.ts'
import {
  buildCustomAgentSystemPrompt,
  buildCustomAgentTask,
  resolveCustomAgentMaxSteps,
  resolveCustomAgentModel,
  resolveCustomAgentTools,
} from './custom-agent-strategy.ts'
import { addSubagentUsage } from '../subagent-usage.ts'
import { runWithAgentRunReadFileLimits } from '../agent-run-read-limits.ts'
import { runWithAgentRunReadonly } from '../agent-run-readonly.ts'
import { isolatedWorkerScope } from './isolated-worker-scope.ts'
import { agentWorkspaceLabel } from '../execution-root.ts'
import { subagentHookCallbacks } from '../hooks/subagent.ts'
import { isAgentRunReadonly } from '../agent-run-readonly.ts'
import { isToolAllowedInReadonlyMode } from '@shared/tools/readonly-tools.ts'
import { getMcpToolMeta } from '../mcp/mcp-registry.ts'
import { getThreadExecutionContext } from '../thread-execution-context.ts'
import { isAppleDevelopmentToolOffered } from '../apple-development/apple-development-tool-scope.ts'
import { buildProvider, isLocalChatModel } from '../providers/provider-selection.ts'
import { resolveContextWindow } from '../providers/resolve-context-window.ts'

// Only reviewed, root-confined native tools. External execution cannot inherit this authority.
const ISOLATED_WORKER_TOOLS = new Set([
  'read_file',
  'list_dir',
  'search_code',
  'search_codebase',
  'semantic_search',
  'find_files',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'staged_diffs',
  'read_staged_diff',
  'write_file',
  'str_replace',
  'delete_file',
  'rename_file',
  'make_directory',
  'preflight_worktree',
  'prepare_worktree',
])

/**
 * Runs a user-authored subagent (docs/plans/custom-subagents.md, P2).
 *
 * Called directly by the turn rather than through a `task` tool the model may or
 * may not choose to call. Three evals against a real model showed that a turn
 * directive is not enough — asked to delegate, the model answered directly
 * instead — and "the agent you named runs" is a contract, not a request. See the
 * eval result recorded under decision 2 of the plan.
 */
export interface CustomAgentRunContext {
  /** Id of the synthesized `task` card this run streams into. */
  parentToolCallId: string
  parentGoal: string
  /** The parent turn's provider — custom agents inherit its model. */
  provider: LLMProvider
  /** Parent turn's model id, for usage attribution. */
  parentModel: string
  registry: ToolRegistry
  contextWindow: number
  toolSchemaReserve: number
  onChunk: (chunk: StreamChunk) => void
}

function executeAgentTool(
  registry: ToolRegistry,
  allowed: readonly LLMTool[],
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<ToolExecuteResult> {
  if (!allowed.some((tool) => tool.name === name)) {
    throw new Error(`Tool not available to this agent: ${name}`)
  }
  return registry.execute(name, args, signal)
}

export async function runCustomAgent(
  ctx: CustomAgentRunContext,
  agent: AgentMetadata,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted()
  if (agent.unsupportedFields.some((field) => field.field === 'isolation')) {
    throw new Error(
      `Agent "${agent.name}" requests isolation, but custom-agent worktree isolation is unavailable. The agent was not started.`,
    )
  }
  if (agent.isolation === 'worktree' && !isolatedWorkerScope.getStore()) {
    throw new Error(
      `Agent "${agent.name}" requires run_isolated_workers; no isolated worker was started.`,
    )
  }
  const workspace = agentWorkspaceLabel()
  const model = resolveCustomAgentModel(agent.model, ctx.parentModel)
  const usesParentModel = model === ctx.parentModel
  const provider = usesParentModel ? ctx.provider : await buildProvider(model)
  const contextWindow = usesParentModel ? ctx.contextWindow : await resolveContextWindow(model)
  const toolSchemaReserve = usesParentModel
    ? ctx.toolSchemaReserve
    : isLocalChatModel(model)
      ? 2_500
      : 1_000
  // Candidates come from the **registry**, not from the parent turn's offered
  // set, matching how `explore` builds its own tools. The parent's set is
  // narrowed for reasons that are not about safety: with subagents enabled it
  // has no `read_file`/`search_*` at all, because the parent delegates reads to
  // `explore`. Intersecting with it starved a read-only reviewer agent of every
  // tool it needed — it reported that no file content was available rather than
  // reading the file it was pointed at (found by the P2 eval).
  //
  // Read-only is still honoured, and still only ever narrows: an agent that
  // declares `readonly`, or a parent run already in read-only mode, drops every
  // tool that mode forbids so the agent never spends a step on a call the gate
  // would reject.
  // Apple tools stay scoped to enrolled projects here exactly as in the parent run.
  const readonly = agent.readonly || isAgentRunReadonly()
  const projectId = getThreadExecutionContext()?.projectId
  const available = ctx.registry.toLLMTools().filter(
    (tool) =>
      (!isolatedWorkerScope.getStore() || ISOLATED_WORKER_TOOLS.has(tool.name)) &&
      isAppleDevelopmentToolOffered(tool.name, projectId) &&
      (!readonly ||
        isToolAllowedInReadonlyMode(tool.name, {
          ...(tool.name.startsWith('mcp__')
            ? { mcpAnnotations: getMcpToolMeta(tool.name)?.annotations }
            : {}),
        })),
  )
  const tools = resolveCustomAgentTools(available, agent)
  const toolNames = tools.map((tool) => tool.name)
  // A child owns its allowance, even when launched inside a parent activation scope.
  const skillTurn = createSkillActivationTurn([], toolNames, 0, 'subagent')
  const systemPrompt =
    buildCustomAgentSystemPrompt(agent) + buildSkillsCatalogBlock(toolNames, 'subagent')
  const userTask = buildCustomAgentTask({ prompt, parentGoal: ctx.parentGoal, workspace })

  const subagentMessages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userTask },
  ]
  const subagentBudget = conversationTokenBudget(subagentMessages, contextWindow, {
    reserveTokens: toolSchemaReserve,
  })
  const readLimits = readFileLimitsForSubagent(subagentBudget)

  const run = async (): Promise<string> => {
    const { summary, session } = await runSubagent({
      provider,
      prompt,
      parentGoal: `${ctx.parentGoal}\nWorkspace: ${workspace}`,
      tools,
      parentToolCallId: ctx.parentToolCallId,
      signal,
      maxSteps: resolveCustomAgentMaxSteps(agent.maxTurns),
      maxContextTokens: contextWindow,
      toolSchemaReserveTokens: toolSchemaReserve,
      executeTool: (name, args, sig) => executeAgentTool(ctx.registry, tools, name, args, sig),
      onSubagentChunk: ctx.onChunk,
      systemPrompt,
      userTask,
      usageModel: model,
      kind: 'custom',
      agentName: agent.name,
      ...(agent.color !== null ? { agentColor: agent.color } : {}),
      // The same `subagentStart` gate and `subagentStop` notification every other
      // subagent fires; the matcher is the subagent type, so a user's hooks can
      // gate their own agents by name with no extra wiring.
      ...subagentHookCallbacks({ usageModel: model }),
    })

    addSubagentUsage(session.usage ?? { inputTokens: 0, outputTokens: 0 })
    signal.throwIfAborted()
    if (session.status === 'error') throw new Error(summary)
    return summary
  }

  return runWithSkillActivationTurn(skillTurn, () =>
    runWithAgentRunReadFileLimits(readLimits, () =>
      // `readonly: true` (Cursor) / `permissionMode: plan` (Claude Code) map onto
      // Copse's existing no-mutations scope. This only ever narrows: a parent turn
      // already in read-only mode stays read-only for the agent too.
      agent.readonly ? runWithAgentRunReadonly(true, run) : run(),
    ),
  )
}
