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
  resolveCustomAgentTools,
} from './custom-agent-strategy.ts'
import { addSubagentUsage } from '../subagent-usage.ts'
import { runWithAgentRunReadFileLimits } from '../agent-run-read-limits.ts'
import { runWithAgentRunReadonly } from '../agent-run-readonly.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { subagentHookCallbacks } from '../hooks/subagent.ts'
import { isAgentRunReadonly } from '../agent-run-readonly.ts'
import { isToolAllowedInReadonlyMode } from '@shared/tools/readonly-tools.ts'
import { getMcpToolMeta } from '../mcp/mcp-registry.ts'

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
  const workspace = getWorkspaceRoot() ?? '(none)'
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
  const readonly = agent.readonly || isAgentRunReadonly()
  const available = ctx.registry.toLLMTools().filter(
    (tool) =>
      !readonly ||
      isToolAllowedInReadonlyMode(tool.name, {
        ...(tool.name.startsWith('mcp__')
          ? { mcpAnnotations: getMcpToolMeta(tool.name)?.annotations }
          : {}),
      }),
  )
  const tools = resolveCustomAgentTools(available, agent)
  const systemPrompt = buildCustomAgentSystemPrompt(agent)
  const userTask = buildCustomAgentTask({ prompt, parentGoal: ctx.parentGoal, workspace })

  const subagentMessages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userTask },
  ]
  const subagentBudget = conversationTokenBudget(subagentMessages, ctx.contextWindow, {
    reserveTokens: ctx.toolSchemaReserve,
  })
  const readLimits = readFileLimitsForSubagent(subagentBudget)

  const run = async (): Promise<string> => {
    const { summary, session } = await runSubagent({
      provider: ctx.provider,
      prompt,
      parentGoal: `${ctx.parentGoal}\nWorkspace: ${workspace}`,
      tools,
      parentToolCallId: ctx.parentToolCallId,
      signal,
      maxSteps: resolveCustomAgentMaxSteps(agent.maxTurns),
      maxContextTokens: ctx.contextWindow,
      toolSchemaReserveTokens: ctx.toolSchemaReserve,
      executeTool: (name, args, sig) => executeAgentTool(ctx.registry, tools, name, args, sig),
      onSubagentChunk: ctx.onChunk,
      systemPrompt,
      userTask,
      usageModel: ctx.parentModel,
      kind: 'custom',
      agentName: agent.name,
      ...(agent.color !== null ? { agentColor: agent.color } : {}),
      // The same `subagentStart` gate and `subagentStop` notification every other
      // subagent fires; the matcher is the subagent type, so a user's hooks can
      // gate their own agents by name with no extra wiring.
      ...subagentHookCallbacks({ usageModel: ctx.parentModel }),
    })

    addSubagentUsage(session.usage ?? { inputTokens: 0, outputTokens: 0 })
    return summary
  }

  return runWithAgentRunReadFileLimits(readLimits, () =>
    // `readonly: true` (Cursor) / `permissionMode: plan` (Claude Code) map onto
    // Copse's existing no-mutations scope. This only ever narrows: a parent turn
    // already in read-only mode stays read-only for the agent too.
    agent.readonly ? runWithAgentRunReadonly(true, run) : run(),
  )
}
