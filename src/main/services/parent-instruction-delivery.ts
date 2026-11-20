import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { hasLastUsage, type ProviderWithUsage } from '@copse/llm/provider-usage.ts'

interface ParentInstructionDelivery {
  provider: LLMProvider & ProviderWithUsage
  readonly hasPendingInstructions: boolean
  requireDelivery: (block: string) => void
}

/**
 * Observe only parent requests, after the loop has budgeted their messages.
 * Discovery must inject the blocks before budgeting; this observer never does.
 * If trimming omits a block, edits stay deferred until delivery or the existing
 * step/call/deadline bounds end the run.
 */
export function createParentInstructionDelivery(provider: LLMProvider): ParentInstructionDelivery {
  const pendingBlocks = new Set<string>()
  return {
    get hasPendingInstructions(): boolean {
      return pendingBlocks.size > 0
    },
    requireDelivery(block): void {
      pendingBlocks.add(block)
    },
    provider: {
      get compactionIdentity(): LLMProvider['compactionIdentity'] {
        return provider.compactionIdentity
      },
      get lastUsage(): ProviderWithUsage['lastUsage'] {
        return hasLastUsage(provider) ? provider.lastUsage : null
      },
      stream(messages, tools, signal, streamOptions): AsyncIterable<ProviderStreamChunk> {
        const leadingSystem = messages.find((message) => message.role === 'system')
        if (!signal?.aborted && leadingSystem?.role === 'system') {
          for (const block of pendingBlocks) {
            if (leadingSystem.content.includes(block)) pendingBlocks.delete(block)
          }
        }
        return provider.stream(messages, tools, signal, streamOptions)
      },
    },
  }
}
