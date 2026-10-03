import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  LLMMessage,
  LLMProvider,
  LLMStreamOptions,
  LLMTool,
  ProviderStreamChunk,
} from '@copse/llm/wire-types.ts'

/** Record the exact normalized messages and tools presented to the provider on every call. */
export function recordTerminalBenchProviderRequests(
  provider: LLMProvider,
  path: string,
  /** Sampling mode and parameters in force, stamped on every request line. */
  sampling?: { mode: string; params: unknown },
): LLMProvider {
  let sequence = 0
  mkdirSync(dirname(path), { recursive: true })
  return {
    async *stream(
      messages: LLMMessage[],
      tools: LLMTool[],
      signal?: AbortSignal,
      options?: LLMStreamOptions,
    ): AsyncIterable<ProviderStreamChunk> {
      sequence += 1
      appendFileSync(
        path,
        `${JSON.stringify({
          schemaVersion: 1,
          type: 'request',
          sequence,
          recordedAt: new Date().toISOString(),
          messages,
          ...(sampling ? { sampling } : {}),
          tools,
          ...(options?.suppressReasoning ? { suppressReasoning: true } : {}),
          ...(options?.toolChoice ? { toolChoice: options.toolChoice.name } : {}),
        })}\n`,
      )
      yield* provider.stream(messages, tools, signal, options)
    },
  }
}
