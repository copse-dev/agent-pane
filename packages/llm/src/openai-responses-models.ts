/**
 * Which first-party OpenAI models Copse drives over `/v1/responses` rather than
 * `/v1/chat/completions`.
 *
 * The split is about reasoning, not novelty. Reasoning models emit thinking
 * alongside their answer, and Chat Completions has nowhere to put it — OpenAI's
 * schema has no reasoning field at all, so on that endpoint a GPT-5-class model's
 * reasoning is simply not returned. Responses carries it as its own output item,
 * which is what lets Copse show thinking for these models and lets the model keep
 * reasoning across a tool-calling chain instead of restarting each turn.
 *
 * Non-reasoning models (gpt-4o and friends) gain nothing from the move and keep
 * the older path, which is well-exercised here.
 *
 * Matched by prefix so dated snapshots (`gpt-5.6-sol-2026-07-01`) resolve too.
 * Mirrors the model list LLM 0.32 moved to Responses (simonw/llm#1435), plus the
 * gpt-5.6 family that shipped after it.
 */
const RESPONSES_MODEL_PREFIXES = ['gpt-5', 'o1', 'o3', 'o4'] as const

/**
 * Whether `model` is a first-party OpenAI id that should use the Responses API.
 *
 * Takes a bare model id, not a namespaced selection: OpenRouter and extra
 * providers reach OpenAI models by their own routing and pick their transport
 * from provider config, so they must not be caught here.
 */
export function usesResponsesApi(model: string): boolean {
  return RESPONSES_MODEL_PREFIXES.some(
    (prefix) =>
      model === prefix || model.startsWith(`${prefix}-`) || model.startsWith(`${prefix}.`),
  )
}
