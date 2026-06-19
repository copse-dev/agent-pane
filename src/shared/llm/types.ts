import type { LLMMessage, LLMTool, StreamChunk } from '@shared/types'

export interface LLMProvider {
  stream(messages: LLMMessage[], tools: LLMTool[], signal?: AbortSignal): AsyncIterable<StreamChunk>
}
