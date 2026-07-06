// The provider contract is owned by the LLM module; re-exported here so
// `@shared/types` consumers are unchanged. (Previously duplicated verbatim in
// both this file and src/shared/llm/types.ts — now a single source of truth.)
export type { LLMProvider } from '@copse/llm/wire-types.ts'
