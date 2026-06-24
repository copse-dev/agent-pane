import { runAgentLoop } from '@shared/agent/run-agent-loop.ts'
import type { LLMMessage, LLMProvider, LLMTool } from '@shared/types'
import type { AcpTurnContext, AcpTurnRunner } from './acp-agent-server.ts'

/**
 * Bridge Copse's `runAgentLoop` into the ACP {@link AcpTurnRunner} contract.
 *
 * Dependencies are injected rather than imported from Electron-coupled
 * services so the bridge stays headless and testable; the `copse --acp` entry
 * point supplies concrete implementations built from the tool registry and the
 * provider factory (the registry/provider headless bootstrap is the remaining
 * integration work — see issue #264).
 *
 * History is retained across prompts for the lifetime of the runner so an ACP
 * session behaves as one continuous conversation.
 */
export interface CopseAcpRunnerDeps {
  /** Build (or reuse) the LLM provider for a run. */
  buildProvider(): Promise<LLMProvider> | LLMProvider
  /** Tools exposed to the agent for this session. */
  buildTools(): LLMTool[]
  /** Execute a tool once permission (if required) has been granted. */
  executeTool(name: string, args: unknown, signal: AbortSignal, toolCallId: string): Promise<string>
  /** System prompt injected on the first turn only. */
  buildSystemPrompt?(): Promise<string> | string
  /** Decide whether a tool call must be approved by the ACP client first. */
  needsPermission?(name: string, args: unknown): boolean
  maxContextTokens?: number
  usageModel?: string
}

export function createCopseAcpTurnRunner(deps: CopseAcpRunnerDeps): AcpTurnRunner {
  const history: LLMMessage[] = []

  return async (ctx: AcpTurnContext) => {
    const provider = await deps.buildProvider()

    if (history.length === 0 && deps.buildSystemPrompt) {
      history.push({ role: 'system', content: await deps.buildSystemPrompt() })
    }
    history.push({ role: 'user', content: ctx.prompt })

    await runAgentLoop({
      provider,
      messages: history,
      tools: deps.buildTools(),
      signal: ctx.signal,
      onChunk: (chunk) => {
        void ctx.emit(chunk)
      },
      executeTool: async (name, args, signal, toolCallId) => {
        if (deps.needsPermission?.(name, args)) {
          const decision = await ctx.requestPermission({ toolCallId, title: name, rawInput: args })
          if (decision !== 'allow') {
            return decision === 'cancelled'
              ? 'Tool call cancelled by the user.'
              : 'Tool call rejected by the user.'
          }
        }
        return deps.executeTool(name, args, signal, toolCallId)
      },
      ...(deps.usageModel !== undefined ? { usageModel: deps.usageModel } : {}),
      ...(deps.maxContextTokens !== undefined ? { maxContextTokens: deps.maxContextTokens } : {}),
    })

    return { stopReason: 'end_turn' }
  }
}
