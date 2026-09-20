import { memberOf } from '@copse/std/member-of.ts'

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
export const isServiceTier: (value: string) => value is ServiceTier = memberOf(SERVICE_TIERS)

/**
 * Non-standard processing modes that need their own usage bucket. Standard
 * processing remains the unbucketed portion of a model's usage, which keeps
 * data written before tier-aware pricing valid.
 */
export const USAGE_SERVICE_TIERS = ['flex', 'priority', 'scale'] as const

export type UsageServiceTier = (typeof USAGE_SERVICE_TIERS)[number]

/** Convert OpenAI's response spelling into the bucket used for pricing. */
export function usageServiceTierFor(value: ServiceTier): UsageServiceTier | undefined {
  switch (value) {
    case 'flex':
    case 'priority':
    case 'scale':
      return value
    case 'auto':
    case 'default':
      return undefined
  }
}

/**
 * Choose a pricing bucket from evidence recorded for one call. A response tier
 * wins whenever OpenAI supplied one: it is the processing mode actually used,
 * whereas the request can be routed differently by the service.
 */
export function usageServiceTierForCall(
  requested: ServiceTier | undefined,
  response: ServiceTier | undefined,
): UsageServiceTier | undefined {
  return response === undefined
    ? requested === undefined
      ? undefined
      : usageServiceTierFor(requested)
    : usageServiceTierFor(response)
}

/** One offerable tier: the stored value, plus how to describe it to a user. */
export interface ServiceTierChoice {
  /** Stored value. `''` means "send no `service_tier`" — standard processing. */
  value: '' | ServiceTier
  label: string
  description: string
}

/**
 * The tiers worth offering in a picker, in the order they should appear.
 *
 * A deliberate subset of {@link SERVICE_TIERS}, because "what the API accepts"
 * and "what a person should be offered" are different questions:
 *
 * - `scale` is omitted — it bills against committed reserved throughput bought
 *   on a ≥30-day contract, so presenting it as a per-chat toggle would offer a
 *   capacity most accounts do not have.
 * - `auto` and `default` are omitted — both mean "standard processing", which
 *   the empty value already expresses by sending no field at all. Listing three
 *   spellings of the same outcome invites the question of how they differ.
 *
 * Shaped like ACP's `AcpConfigChoice` so one picker can render both, but the
 * source differs and that matters: ACP options are *advertised* by the agent at
 * probe time, while OpenAI advertises nothing. This list is Copse's own, and
 * has to be maintained by hand when OpenAI's tiers change.
 */
export const SERVICE_TIER_CHOICES: readonly ServiceTierChoice[] = [
  {
    value: '',
    label: 'Standard',
    description: 'Default pay-as-you-go processing. Sends no service_tier field.',
  },
  {
    value: 'flex',
    label: 'Flex',
    description: 'Cheaper per token, slower, and may queue or fail under load. Suits batch work.',
  },
  {
    value: 'priority',
    label: 'Priority',
    description: 'Faster and more consistent, at a higher per-token price. Marketed as Fast mode.',
  },
]

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
