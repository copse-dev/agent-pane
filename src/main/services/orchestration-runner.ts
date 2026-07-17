import { AsyncLocalStorage } from 'node:async_hooks'
import { runSubagent } from '@copse/agent/run-subagent.ts'
import { conversationTokenBudget } from '@copse/agent/trim-history.ts'
import { readFileLimitsForSubagent } from '@copse/agent/read-file-limits.ts'
import type { LLMMessage, LLMTool, StreamChunk, ToolExecuteResult } from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'
import { buildProvider } from './providers/provider-selection.ts'
import { resolveContextWindow } from './providers/resolve-context-window.ts'
import { getSettingTrimmed } from './storage/settings.ts'
import { addSubagentUsage } from './subagent-usage.ts'
import { runWithAgentRunReadFileLimits } from './agent-run-read-limits.ts'
import { getWorkspaceRoot } from './workspace.ts'
import { getGitStatusText } from './github/git-service.ts'
import {
  DEFAULT_ORCHESTRATION_WORKER_MODEL,
  ORCHESTRATION_WORKER_MAX_STEPS,
  ORCHESTRATION_WORKER_MODEL_SETTING,
  ORCHESTRATION_WORKER_SYSTEM_PROMPT,
  ORCHESTRATION_WORKER_TOOL_NAMES,
  buildStepObservation,
  buildWorkerTask,
} from './orchestration-strategy.ts'

/** Resolve the configured worker model id (empty setting -> cheap default). */
export function resolveOrchestrationWorkerModelId(): string {
  return getSettingTrimmed(ORCHESTRATION_WORKER_MODEL_SETTING) || DEFAULT_ORCHESTRATION_WORKER_MODEL
}

/**
 * Run-scoped context for the orchestration worker, set by agent-service around
 * a `delegate_step` tool call. ALS-scoped like the explore seam (not a module
 * slot): the orchestrator may fan out several independent delegated steps
 * concurrently, and each call must see only its own parentToolCallId.
 */
export interface OrchestrationRunnerContext {
  parentToolCallId: string
  parentGoal: string
  /** Cheaper/faster model the delegated step runs on. */
  workerModel: string
  registry: ToolRegistry
  onChunk: (chunk: StreamChunk) => void
}

export type OrchestrationRunner = (opts: {
  step: string
  context: string
  expectedOutcome?: string | undefined
  signal: AbortSignal
}) => Promise<string>

const contextStorage = new AsyncLocalStorage<OrchestrationRunnerContext>()

export function runWithOrchestrationContext<T>(
  ctx: OrchestrationRunnerContext,
  fn: () => Promise<T>,
): Promise<T> {
  return contextStorage.run(ctx, fn)
}

function filterWorkerTools(registry: ToolRegistry): LLMTool[] {
  const names = new Set<string>(ORCHESTRATION_WORKER_TOOL_NAMES)
  return registry.toLLMTools().filter((t) => names.has(t.name))
}

async function executeWorkerTool(
  registry: ToolRegistry,
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<ToolExecuteResult> {
  if (!(ORCHESTRATION_WORKER_TOOL_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Tool not allowed in orchestration worker: ${name}`)
  }
  return registry.execute(name, args, signal)
}

// The worker model may be an LM Studio model, which advertises a smaller
// tool-schema budget than cloud providers (same rule as agent-service's
// toolSchemaReserveForModel, restated here to avoid an import cycle).
function workerToolSchemaReserve(model: string): number {
  return model === 'lm-studio' || model.startsWith('lmstudio:') ? 2_500 : 1_000
}

export function getOrchestrationRunner(): OrchestrationRunner | null {
  const ctx = contextStorage.getStore()
  if (!ctx) return null
  return async ({ step, context, expectedOutcome, signal }) => {
    const provider = await buildProvider(ctx.workerModel)
    const contextWindow = await resolveContextWindow(ctx.workerModel)
    const toolSchemaReserve = workerToolSchemaReserve(ctx.workerModel)
    const workspace = getWorkspaceRoot() ?? '(none)'
    const userTask = buildWorkerTask({ step, context, expectedOutcome, workspace })

    const subagentMessages: LLMMessage[] = [
      { role: 'system', content: ORCHESTRATION_WORKER_SYSTEM_PROMPT },
      { role: 'user', content: userTask },
    ]
    const subagentBudget = conversationTokenBudget(subagentMessages, contextWindow, {
      reserveTokens: toolSchemaReserve,
    })
    const subagentReadLimits = readFileLimitsForSubagent(subagentBudget)

    return runWithAgentRunReadFileLimits(subagentReadLimits, async () => {
      const { summary, session } = await runSubagent({
        provider,
        prompt: step,
        parentGoal: `${ctx.parentGoal}\nWorkspace: ${workspace}`,
        tools: filterWorkerTools(ctx.registry),
        parentToolCallId: ctx.parentToolCallId,
        signal,
        maxSteps: ORCHESTRATION_WORKER_MAX_STEPS,
        maxContextTokens: contextWindow,
        toolSchemaReserveTokens: toolSchemaReserve,
        executeTool: (name, args, sig) => executeWorkerTool(ctx.registry, name, args, sig),
        onSubagentChunk: ctx.onChunk,
        systemPrompt: ORCHESTRATION_WORKER_SYSTEM_PROMPT,
        userTask,
        usageModel: ctx.workerModel,
        kind: 'delegate',
      })

      // Worker tokens are billed at the worker model's rate; like the advisor
      // they fold into the run's aux-model usage line for now.
      addSubagentUsage(session.usage ?? { inputTokens: 0, outputTokens: 0 })

      // The observation the orchestrator reviews between steps: the worker's
      // report plus what the working tree actually looks like now.
      const workingTree = await getGitStatusText().catch(() => '')
      return buildStepObservation({ report: summary, workingTree })
    })
  }
}
