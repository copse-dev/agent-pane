// Tool-call identity for providers that don't supply it.
//
// The agent loop correlates a tool *result* back to the tool *call* purely by
// id (`ToolResult.toolCallId`), so an id is not cosmetic — it is the join key.
// OpenAI always sends one, but the OpenAI-compatible servers Copse also talks
// to (LM Studio, llama.cpp, vLLM, Ollama, and assorted cloud aggregators) may
// stream a tool call with no `id` at all. Two such calls in one turn both
// arrive as `''`, collide on that join key, and the second result overwrites
// the first — the model then sees the wrong answer to its own question.
//
// Synthesizing an id at the adapter boundary keeps that failure impossible:
// everything downstream can assume a tool call is uniquely identified.

/**
 * Marks an id Copse generated because the provider omitted one. Mirrors the
 * `tc_` convention used by `llm` (simonw/llm#1481), which fixed this same bug.
 */
const SYNTHETIC_TOOL_CALL_ID_PREFIX = 'tc_'

/** A fresh, unique stand-in id for a tool call the provider left unidentified. */
export function synthesizeToolCallId(): string {
  return `${SYNTHETIC_TOOL_CALL_ID_PREFIX}${globalThis.crypto.randomUUID()}`
}

/**
 * The provider's tool-call id, or a synthesized one when it is missing or blank.
 *
 * Whitespace-only counts as missing: a server that pads an empty field still
 * leaves every call sharing one useless key.
 */
export function toolCallIdOrSynthesized(id: string | null | undefined): string {
  return id && id.trim() !== '' ? id : synthesizeToolCallId()
}
