/**
 * OpenAI's `service_tier` request field.
 *
 * The tier chooses how OpenAI processes a request: `flex` is slower and
 * cheaper, `priority` is quicker at a higher per-token price, `scale` is
 * committed reserved throughput, and omitting the field entirely means
 * standard processing. Which tiers a given model accepts still varies by
 * model — this is what the API recognises, not what every model allows.
 *
 * These are the values OpenAI documents, and they match the SDK's own union.
 * Note that OpenAI markets Priority processing as **"Fast mode"** — a product
 * name, not a request value. `llm`'s `-o service_tier fast` is that tool's own
 * shorthand; sending `fast` to the API is a 400.
 */
export const SERVICE_TIERS = ['auto', 'default', 'flex', 'priority', 'scale'] as const

export type ServiceTier = (typeof SERVICE_TIERS)[number]

/** Narrow an arbitrary stored string to a tier the API will accept. */
export function isServiceTier(value: string): value is ServiceTier {
  return (SERVICE_TIERS as readonly string[]).includes(value)
}

/**
 * The `service_tier` body fragment, or an empty object when unset.
 *
 * Takes an already-narrowed {@link ServiceTier} so an unrecognised value cannot
 * reach a request at all. Validation belongs at the boundary that can report it
 * — the settings schema, and `provider-selection.ts` for values stored before
 * this enum existed — rather than silently here, where a bad tier would either
 * vanish without trace or be sent for OpenAI to reject.
 *
 * Returns an empty object when unset, so spreading it adds nothing.
 */
export function serviceTierBody(serviceTier: ServiceTier | undefined): Record<string, unknown> {
  return serviceTier ? { service_tier: serviceTier } : {}
}
