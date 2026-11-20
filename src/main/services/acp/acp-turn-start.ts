import { createHookRegistry, mergeBlockingOutcomes } from '@copse/agent/hooks/hook-registry.ts'
import type { HookRunRecord } from '@copse/agent/hooks/canonical-events.ts'
import type { TodoItem } from '@shared/types/todo.ts'
import type { LLMTool } from '@shared/types'
import type { ToolRegistry } from '../tool-registry.ts'
import { setHookRunToolset } from '../hook-run-recorder.ts'

export interface AssembleAcpTurnStartOptions {
  userText: string
  invokedSkills?: readonly string[]
  priorTodos: readonly TodoItem[]
  /** Whether the thread had no prior messages before this one; see `TurnStartPayload.firstTurn`. */
  firstTurn: boolean
  model: string
  registry: ToolRegistry
  /**
   * The Copse bridge tools this session's agent actually has: the ones it
   * listed, and none once it showed it dropped them (#4142), or none when it
   * was offered no bridge or never listed it (#4144).
   */
  bridgeToolNames: readonly string[]
  signal: AbortSignal
  resolveGithubRepoSlug?: () => Promise<string | null>
  resolvePluginSetting?: (pluginId: string, key: string) => unknown
  recordHookRun?: (record: HookRunRecord) => void
}

/**
 * Fire the canonical turn-start assembly for an external ACP executor.
 *
 * Only the Copse bridge tools the agent actually has are visible here, so the
 * guidance never names a tool the agent was offered but did not get. An
 * external agent's private tools are outside the host's contract and cannot
 * safely be named by first-party hooks. Each name must also still be served:
 * the registry's MCP export is what the bridge answers calls from, so a tool
 * unregistered since the listing is not advertised to a hook or the durable run
 * record.
 */
export async function assembleAcpTurnStart(
  options: AssembleAcpTurnStartOptions,
): Promise<string | undefined> {
  const agentHas = new Set(options.bridgeToolNames)
  const bridgedTools = options.registry
    .toMcpTools()
    .filter((tool) => agentHas.has(tool.name))
    .map((tool): LLMTool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }))
  setHookRunToolset(bridgedTools)

  const turnStart = await createHookRegistry().emit(
    'turnStart',
    {
      userText: options.userText,
      ...(options.invokedSkills ? { invokedSkills: options.invokedSkills } : {}),
      priorTodos: options.priorTodos,
      firstTurn: options.firstTurn,
      executor: 'acp',
      model: options.model,
      toolNames: bridgedTools.map((tool) => tool.name),
    },
    {
      signal: options.signal,
      ...(options.resolveGithubRepoSlug
        ? { resolveGithubRepoSlug: options.resolveGithubRepoSlug }
        : {}),
      ...(options.resolvePluginSetting
        ? { resolvePluginSetting: options.resolvePluginSetting }
        : {}),
      ...(options.recordHookRun ? { recordHookRun: options.recordHookRun } : {}),
    },
  )
  return mergeBlockingOutcomes(turnStart.outcomes).injectContext
}
