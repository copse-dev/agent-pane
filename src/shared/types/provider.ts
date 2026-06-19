import type { LLMMessage } from './llm.ts'
import type { LLMTool } from './tools.ts'
import type { StreamChunk } from './stream.ts'

export interface LLMProvider {
  stream(messages: LLMMessage[], tools: LLMTool[], signal?: AbortSignal): AsyncIterable<StreamChunk>
}
