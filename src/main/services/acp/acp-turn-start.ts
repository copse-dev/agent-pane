import { createHookRegistry, mergeBlockingOutcomes } from '@copse/agent/hooks/hook-registry.ts'
import type { HookRunRecord } from '@copse/agent/hooks/canonical-events.ts'
import type { TodoItem } from '@shared/types/todo.ts'
import type { LLMTool } from '@shared/types'
import type { ToolRegistry } from '../tool-registry.ts'
import { setHookRunToolset } from '../hook-run-recorder.ts'
import { activeBridgeToolNames } from './acp-native-bridge.ts'

export interface AssembleAcpTurnStartOptions {
  userText: string
  priorTodos: readonly TodoItem[]
  model: string
  registry: ToolRegistry
  signal: AbortSignal
  resolveGithubRepoSlug?: () => Promise<string | null>
  resolvePluginSetting?: (pluginId: string, key: string) => unknown
  recordHookRun?: (record: HookRunRecord) => void
}

/**
 * Fire the canonical turn-start assembly for an external ACP executor.
 *
 * Only Copse's actually mounted MCP bridge tools are visible here: an external
 * agent's private tools are outside the host's contract and cannot safely be
 * named by first-party hooks. MCP-schema conversion happens before both this
 * fingerprint and the real bridge list, so a schema the bridge omits is not
 * falsely advertised to a hook or the durable run record.
 */
export async function assembleAcpTurnStart(
  options: AssembleAcpTurnStartOptions,
): Promise<string | undefined> {
  const offeredNames = new Set(activeBridgeToolNames())
  const bridgedTools = options.registry
    .toMcpTools()
    .filter((tool) => offeredNames.has(tool.name))
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
      priorTodos: options.priorTodos,
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
