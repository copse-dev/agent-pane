/**
 * OpenAI's `service_tier` request field, as an untyped body fragment.
 *
 * The tier chooses how OpenAI processes a request: `flex` is slower and
 * cheaper, `priority` (marketed as Fast mode) is quicker at a higher
 * per-token price, and the default — omitting the field — is standard
 * processing. Which tiers a model accepts varies by model.
 *
 * Deliberately typed as a loose record rather than the SDK's
 * `"scale" | "default" | "auto" | "flex" | "priority" | null` union. That union
 * is already behind the API: `llm` 0.32 documents `-o service_tier fast`, and
 * `fast` is not in it. Pinning to the SDK's list would reject tier names the
 * API accepts today, and again every time OpenAI adds one, so the value is
 * passed through and OpenAI validates it — a wrong tier fails visibly with a
 * 400 rather than being silently dropped.
 *
 * Returns an empty object when unset, so spreading it adds nothing.
 */
export function serviceTierBody(serviceTier: string | undefined): Record<string, unknown> {
  return serviceTier ? { service_tier: serviceTier } : {}
}
