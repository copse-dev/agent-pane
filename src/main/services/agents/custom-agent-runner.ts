import { AsyncLocalStorage } from 'node:async_hooks'
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
import { getAgent } from './agents-registry.ts'
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

/**
 * Runs a user-authored subagent (docs/plans/custom-subagents.md, P2).
 *
 * ALS-scoped rather than a module slot, like the explore seam: the parent may
 * have several `task` calls in flight, and a single slot would hand one call's
 * parentToolCallId to a sibling.
 */
export interface CustomAgentRunnerContext {
  parentToolCallId: string
  parentGoal: string
  /** Provider for `model: inherit` — the parent turn's own. */
  provider: LLMProvider
  /** Parent turn's model id, used for usage attribution when inheriting. */
  parentModel: string
  registry: ToolRegistry
  /** Tools this turn was offering; a definition can only narrow them. */
  parentTools: readonly LLMTool[]
  contextWindow: number
  toolSchemaReserve: number
  onChunk: (chunk: StreamChunk) => void
  /**
   * The agent the user invoked this turn. The tool validates against this, so a
   * model that invents a different `subagent_type` cannot reach another
   * definition.
   */
  invokedAgentName: string
}

export type CustomAgentRunner = (opts: {
  subagentType: string
  prompt: string
  signal: AbortSignal
}) => Promise<string>

const contextStorage = new AsyncLocalStorage<CustomAgentRunnerContext>()

export function runWithCustomAgentContext<T>(
  ctx: CustomAgentRunnerContext,
  fn: () => Promise<T>,
): Promise<T> {
  return contextStorage.run(ctx, fn)
}

function executeAgentTool(
  registry: ToolRegistry,
  allowed: readonly LLMTool[],
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<ToolExecuteResult> {
  if (!allowed.some((tool) => tool.name === name)) {
    throw new Error(`Tool not allowed in the "${name}" agent's tool list: ${name}`)
  }
  return registry.execute(name, args, signal)
}

async function runAgent(
  ctx: CustomAgentRunnerContext,
  agent: AgentMetadata,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const workspace = getWorkspaceRoot() ?? '(none)'
  const tools = resolveCustomAgentTools(ctx.parentTools, agent)
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
      // The same `subagentStart` gate and `subagentStop` notification every
      // other subagent fires; the matcher is the subagent type, so a user's
      // hooks can gate their own agents by name with no extra wiring.
      ...subagentHookCallbacks({ usageModel: ctx.parentModel }),
    })

    addSubagentUsage(session.usage ?? { inputTokens: 0, outputTokens: 0 })
    return summary
  }

  return runWithAgentRunReadFileLimits(readLimits, () =>
    // `readonly: true` (Cursor) / `permissionMode: plan` (Claude Code) map onto
    // Copse's existing no-mutations scope, so the definition narrows the run
    // rather than being quietly ignored.
    agent.readonly ? runWithAgentRunReadonly(true, run) : run(),
  )
}

export function getCustomAgentRunner(): CustomAgentRunner | null {
  const ctx = contextStorage.getStore()
  if (!ctx) return null
  return async ({ subagentType, prompt, signal }) => {
    // The registry refreshes on workspace change, so the name captured when the
    // turn started may be gone by the time the model calls the tool. Report it
    // as a tool result the model can recover from, never as a throw.
    if (subagentType !== ctx.invokedAgentName) {
      return (
        `Error: this turn invoked the "${ctx.invokedAgentName}" agent, not "${subagentType}". ` +
        `Call task with subagent_type "${ctx.invokedAgentName}".`
      )
    }
    const agent = getAgent(subagentType)
    if (!agent) {
      return `Error: no agent named "${subagentType}" is available. It may have been renamed or removed.`
    }
    return runAgent(ctx, agent, prompt, signal)
  }
}
