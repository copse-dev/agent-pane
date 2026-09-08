/**
 * A resolved provider, described rather than constructed: the concrete model
 * id, the wire protocol, the endpoint, and the generation parameters the user
 * tuned for the selection. The desktop resolves a model selection into one of
 * these (`describeProvider`) and builds its client from it; a container run
 * carries the same description into the guest and builds the same client
 * there. Settings are read once, on the desktop, so a setting cannot change
 * meaning between the two — before this the guest rebuilt a narrower client
 * of its own and lost the parameters, OpenRouter's privacy routing and the
 * OpenAI transport choices along the way.
 *
 * Settings-free by design: nothing here reads the store or the environment,
 * so the guest, which has neither, can build from it. Keys are not part of a
 * description; they travel separately and are handed to the builder.
 *
 * The schema is the source of the type (the supervisor's task schema sets the
 * pattern): the guest validates `run.json` against it and gets the same type
 * the desktop wrote.
 */
import { z } from 'zod'
import type { LLMProvider } from '@shared/types'
import {
  createExtraCloudProvider,
  createLMStudioProvider,
  createOpenRouterProvider,
  createProvider,
} from '@copse/llm/create-provider.ts'
import { OPENROUTER_BASE_URL } from '@copse/llm/openrouter.ts'
import { REASONING_LEVELS, type ModelParameters } from '@copse/llm/model-parameters.ts'
import { SERVICE_TIERS } from '@copse/llm/service-tier.ts'

/** `ModelParameters` as a schema; every field optional, absent meaning "send nothing". */
const modelParametersSchema = z
  .object({
    reasoning: z.enum(REASONING_LEVELS).optional(),
    maxOutputTokens: z.number().optional(),
    temperature: z.number().optional(),
    topP: z.number().optional(),
    topK: z.number().optional(),
    minP: z.number().optional(),
    presencePenalty: z.number().optional(),
    repetitionPenalty: z.number().optional(),
  })
  .strict()

const common = {
  /** The id the endpoint expects: prefix stripped, aliases resolved. */
  model: z.string().min(1),
  /** Which stored key the description is used with; the key itself travels apart. */
  apiKeySlug: z.string().min(1),
  /**
   * Typed as the providers take it rather than inferred: zod types an absent
   * optional as `| undefined`, which exact optional properties refuse where
   * `ModelParameters` is consumed. The object schema still does the checking.
   */
  params: z.custom<ModelParameters>((value) => modelParametersSchema.safeParse(value).success),
}

export const providerDescriptionSchema = z.discriminatedUnion('kind', [
  /** LM Studio, over its own transport when the desktop can use it. */
  z.object({ kind: z.literal('lm-studio'), ...common, url: z.url() }).strict(),
  /** Any OpenAI-compatible endpoint: an extra provider, or LM Studio as the guest reaches it. */
  z
    .object({
      kind: z.literal('openai-compatible'),
      ...common,
      url: z.url(),
      label: z.string().min(1),
      /** A local server: usable without a key, usage not reported by default. */
      local: z.boolean(),
      includeUsage: z.boolean(),
      /** Null rather than absent, so the inferred type has no optional to narrow. */
      apiStyle: z.enum(['chat-completions', 'responses']).nullable(),
      extraBody: z.record(z.string(), z.unknown()).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('openrouter'),
      ...common,
      zdrOnly: z.boolean(),
      allowTraining: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('anthropic'), ...common }).strict(),
  z
    .object({
      kind: z.literal('openai'),
      ...common,
      serviceTier: z.enum(SERVICE_TIERS).nullable(),
      forceChatCompletions: z.boolean(),
    })
    .strict(),
])

export type ProviderDescription = z.infer<typeof providerDescriptionSchema>

/** A description read back from disk, or null when the value is not one. */
export function decodeProviderDescription(value: unknown): ProviderDescription | null {
  const parsed = providerDescriptionSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com'
const OPENAI_ENDPOINT = 'https://api.openai.com/v1'

/** The one origin a client built from the description talks to. */
export function providerEndpointUrl(description: ProviderDescription): string {
  switch (description.kind) {
    case 'lm-studio':
    case 'openai-compatible':
      return description.url
    case 'openrouter':
      return OPENROUTER_BASE_URL
    case 'anthropic':
      return ANTHROPIC_ENDPOINT
    case 'openai':
      return OPENAI_ENDPOINT
  }
}

/** Whether a client built from the description needs a key at all. */
export function providerNeedsKey(description: ProviderDescription): boolean {
  if (description.kind === 'lm-studio') return false
  if (description.kind === 'openai-compatible') return !description.local
  return true
}

export interface BuildFromDescriptionOptions {
  /** The key for `apiKeySlug`, or null when there is none. */
  apiKey: string | null
  promptCacheKey?: string
  /** Hosts the user approved for custom endpoints; see `assertProviderHostAllowed`. */
  approvedHosts?: readonly string[]
}

/** The client a description names. Throws when a key it needs is missing. */
export function buildProviderFromDescription(
  description: ProviderDescription,
  options: BuildFromDescriptionOptions,
): LLMProvider {
  const apiKey = options.apiKey ?? ''
  switch (description.kind) {
    case 'lm-studio':
      return createLMStudioProvider(description.url, description.model, apiKey, description.params)
    case 'openai-compatible':
      return createExtraCloudProvider(
        {
          baseUrl: description.url,
          local: description.local,
          includeUsage: description.includeUsage,
          ...(description.apiStyle !== null ? { apiStyle: description.apiStyle } : {}),
          ...(description.extraBody !== null ? { extraBody: description.extraBody } : {}),
        },
        description.model,
        apiKey,
        options.approvedHosts ?? [],
        description.params,
      )
    case 'openrouter':
      if (!apiKey) {
        throw new Error(
          'OpenRouter is not configured. Add an OpenRouter API key in Settings or choose another model.',
        )
      }
      return createOpenRouterProvider(description.model, apiKey, options.promptCacheKey, {
        zdrOnly: description.zdrOnly,
        allowTraining: description.allowTraining,
        params: description.params,
      })
    case 'anthropic':
      return createProvider(
        description.model,
        apiKey ? { anthropicApiKey: apiKey } : {},
        undefined,
        { params: description.params },
      )
    case 'openai':
      return createProvider(
        description.model,
        apiKey ? { openAiApiKey: apiKey } : {},
        options.promptCacheKey,
        {
          params: description.params,
          forceChatCompletions: description.forceChatCompletions,
          ...(description.serviceTier !== null ? { serviceTier: description.serviceTier } : {}),
        },
      )
  }
}
