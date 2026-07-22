import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  LLMMessage,
  LLMProvider,
  LLMTool,
  ProviderStreamChunk,
} from '../../packages/llm/src/wire-types.ts'

/** Record the exact normalized messages and tools presented to the provider on every call. */
export function recordTerminalBenchProviderRequests(
  provider: LLMProvider,
  path: string,
): LLMProvider {
  let sequence = 0
  mkdirSync(dirname(path), { recursive: true })
  return {
    async *stream(
      messages: LLMMessage[],
      tools: LLMTool[],
      signal?: AbortSignal,
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
          tools,
        })}\n`,
      )
      yield* provider.stream(messages, tools, signal)
    },
  }
}
