// LLM message types are owned by the LLM module (they cross the provider
// contract and travel with `@copse/llm` on extraction). Re-exported here so
// `@shared/types` consumers are unchanged.
export type {
  UserContent,
  LLMMessage,
  ToolCallContent,
  ToolResult,
} from '@shared/llm/wire-types.ts'
