import { AnthropicProvider } from './anthropic-provider.ts'
import { OPENROUTER_ATTRIBUTION_HEADERS } from './app-attribution.ts'
import { OpenAIProvider } from './openai-provider.ts'
import { ResponsesProvider } from './responses-provider.ts'
import { MockLLMProvider } from './mock-provider.ts'
import { DEFAULT_CLOUD_MODEL } from './model-catalog.ts'
import { OPENROUTER_BASE_URL } from './openrouter.ts'
import { assertProviderHostAllowed } from './provider-host-policy.ts'
import { validateCredentialBaseUrl } from './credential-url.ts'
import {
  openRouterReasoningBody,
  recommendedOutputCeiling,
  type ModelParameters,
} from './model-parameters.ts'
import { usesResponsesApi } from './openai-responses-models.ts'
import type { ExtraProvider } from './extra-providers.ts'
import type { LLMProvider } from './types.ts'

interface ProviderKeys {
  anthropicApiKey?: string | null
  openAiApiKey?: string | null
}

// OpenAI stores Chat Completions/Responses output for 30 days by default on
// new accounts ("application state"); `store: false` opts each request out.
// Only sent to api.openai.com — OpenAI-compatible servers reached via a custom
// baseURL don't get it (some reject unknown fields, and the parameter is
// OpenAI-specific). See docs/provider-data-policies.md.
const OPENAI_STORE_OPT_OUT = { extraBody: { store: false } } as const

function isWebSearchTool(tool: unknown): tool is { type: 'web_search' } {
  if (!tool || typeof tool !== 'object') return false
  const candidate = tool as { type?: unknown }
  return candidate.type === 'web_search'
}

/**
 * First-party OpenAI over `/v1/responses`.
 *
 * `store: false` is carried across from the Chat Completions path — the privacy
 * default must not change with the transport — and it is exactly why
 * `encryptedReasoning` is needed: with no server-side copy retained, the
 * encrypted blob has to travel on the response or the reasoning is unrecoverable
 * for the next turn.
 */
function openAiResponsesProvider(
  model: string,
  apiKey: string,
  promptCacheKey: string | undefined,
  serviceTier: string | undefined,
): LLMProvider {
  return new ResponsesProvider(model, {
    apiKey,
    reasoningSummaries: true,
    encryptedReasoning: true,
    ...(promptCacheKey ? { promptCacheKey } : {}),
    // A billing choice, not a transport detail: moving a model to Responses
    // must not silently drop the tier the user selected.
    ...(serviceTier ? { serviceTier } : {}),
    ...OPENAI_STORE_OPT_OUT,
  })
}

// `model` is the user's selected model (from settings). It both picks the
// provider family (claude* → Anthropic, gpt* → OpenAI) and is passed through as
// the model id. Falls back to whichever key is present; mock only when
// COPSE_PANEL_MOCK_LLM=1 (tests / dev). `promptCacheKey` is a stable per-thread
// hint forwarded to OpenAI's `prompt_cache_key` to raise cache hit rates (#584).
//
// Reasoning-capable OpenAI models go over the Responses API (see
// openai-responses-models.ts); `forceChatCompletions` pins them back to
// /v1/chat/completions, mirroring llm's `-o chat_completions 1` escape hatch.
export function createProvider(
  model?: string,
  keys: ProviderKeys = {},
  promptCacheKey?: string,
  opts: { serviceTier?: string; params?: ModelParameters; forceChatCompletions?: boolean } = {},
): LLMProvider {
  if (process.env['COPSE_PANEL_MOCK_LLM'] === '1') {
    return new MockLLMProvider()
  }
  const { forceChatCompletions = false } = opts
  const m = model ?? ''
  const cacheKeyOpt = promptCacheKey ? { promptCacheKey } : {}
  // Only ever reaches OpenAI: `service_tier` is an OpenAI request field, and
  // Anthropic rejects unknown body fields outright. Tuned parameters go to every
  // branch instead — each provider maps them onto its own family's wire fields.
  const tierOpt = opts.serviceTier ? { serviceTier: opts.serviceTier } : {}
  const params = opts.params ?? {}
  const paramsOpt = { params }
  // The output ceiling depends on the model *and* the chosen reasoning level, so
  // it is resolved per branch once the id is settled (the fallback branches only
  // learn theirs from an env var).
  const tunedOpts = (id: string): { params: ModelParameters; maxOutputTokens?: number } => {
    const ceiling = recommendedOutputCeiling(id, params)
    return { params, ...(ceiling === undefined ? {} : { maxOutputTokens: ceiling }) }
  }
  const anthropicApiKey = keys.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY']
  const openAiApiKey = keys.openAiApiKey ?? process.env['OPENAI_API_KEY']
  if (m.startsWith('gpt')) {
    if (!openAiApiKey) {
      throw new Error(
        'OpenAI is not configured. Add OPENAI_API_KEY in Settings or choose a Claude or LM Studio model.',
      )
    }
    if (usesResponsesApi(m) && !forceChatCompletions) {
      return openAiResponsesProvider(m, openAiApiKey, promptCacheKey, opts.serviceTier)
    }
    return new OpenAIProvider(m, {
      apiKey: openAiApiKey,
      ...cacheKeyOpt,
      ...tierOpt,
      ...tunedOpts(m),
      ...OPENAI_STORE_OPT_OUT,
    })
  }
  if (m.startsWith('claude')) {
    if (!anthropicApiKey) {
      throw new Error(
        'Anthropic is not configured. Add ANTHROPIC_API_KEY in Settings or choose an OpenAI or LM Studio model.',
      )
    }
    return new AnthropicProvider(m, { apiKey: anthropicApiKey, ...paramsOpt })
  }
  if (anthropicApiKey) {
    return new AnthropicProvider(model ?? process.env['ANTHROPIC_MODEL'] ?? DEFAULT_CLOUD_MODEL, {
      apiKey: anthropicApiKey,
      ...paramsOpt,
    })
  }
  if (openAiApiKey) {
    const id = model ?? process.env['OPENAI_MODEL'] ?? 'gpt-4o'
    if (usesResponsesApi(id) && !forceChatCompletions) {
      return openAiResponsesProvider(id, openAiApiKey, promptCacheKey, opts.serviceTier)
    }
    return new OpenAIProvider(id, {
      apiKey: openAiApiKey,
      ...cacheKeyOpt,
      ...tierOpt,
      ...tunedOpts(id),
      ...OPENAI_STORE_OPT_OUT,
    })
  }
  throw new Error(
    'No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in Settings, pick an LM Studio model, or set COPSE_PANEL_MOCK_LLM=1 for development.',
  )
}

// OpenAI-compatible local servers speak the same chat API, so we reuse
// OpenAIProvider with a custom base URL. apiKey is whatever the local server
// expects (many require any non-empty value, even when auth is disabled).
export function createLocalOpenAIProvider(
  baseURL: string,
  model: string,
  apiKey = 'lm-studio',
  params: ModelParameters = {},
): LLMProvider {
  // LM Studio and other OpenAI-compatible local servers need stream_options.include_usage
  // or they never report prompt/completion tokens — without that, usage chunks (and the
  // Settings usage ledger) stay empty for local models such as qwen.
  const ceiling = recommendedOutputCeiling(model, params)
  return new OpenAIProvider(model, {
    baseURL,
    apiKey: apiKey || 'lm-studio',
    includeUsage: true,
    params,
    ...(ceiling === undefined ? {} : { maxOutputTokens: ceiling }),
  })
}

export const createLMStudioProvider = createLocalOpenAIProvider

// OpenRouter is an OpenAI-compatible cloud aggregator, so it reuses OpenAIProvider
// with OpenRouter's base URL. Unlike a local server it is billed and reports usage,
// so we keep `include_usage` on (includeUsage defaults to false when a baseURL is
// set). `model` is the upstream id with the `openrouter:` prefix already stripped.
//
// `provider: { require_parameters: true }` restricts OpenRouter's routing to
// upstream endpoints that support every parameter we send — crucially `tools`.
// Without it a model id can be load-balanced onto an endpoint that ignores
// function calling, so the model narrates instead of emitting tool calls.
//
// Retention and training are separate OpenRouter policy axes, controlled by
// two independent options (see https://openrouter.ai/docs/guides/features/zdr):
//
// - `zdrOnly` (default ON, `openRouterZdrOnly` setting) sends `zdr: true`,
//   routing only to zero-data-retention endpoints. Trade-off: models with no
//   ZDR endpoint — most `:free` variants — fail with a routing error until
//   the setting is turned off in Settings → Providers → OpenRouter.
// - `allowTraining` (default OFF, `openRouterAllowTraining` setting) controls
//   `data_collection: 'deny'`, which excludes providers that store or train
//   on inputs. Kept independent of `zdrOnly` so relaxing ZDR (to reach
//   retained-but-not-trained endpoints) does not silently re-admit trainers.
//
// OpenRouter also gets `X-OpenRouter-Title` on top of the `HTTP-Referer` +
// `X-Title` pair every provider receives, because it renamed that header and
// accepts either; sending both with one value keeps attribution independent of
// which name wins. See app-attribution.ts.
export function createOpenRouterProvider(
  model: string,
  apiKey: string,
  promptCacheKey?: string,
  opts: { zdrOnly?: boolean; allowTraining?: boolean; params?: ModelParameters } = {},
): LLMProvider {
  const zdrOnly = opts.zdrOnly ?? true
  const allowTraining = opts.allowTraining ?? false
  // Reasoning rides OpenRouter's own unified field rather than the
  // `reasoning_effort` alias, so it normalises across upstream vendors and can
  // express "off". Sampling stays on the standard OpenAI-shaped fields, so the
  // reasoning level is dropped from `params` to avoid sending both spellings.
  const { reasoning: _reasoning, ...sampling } = opts.params ?? {}
  // Read from `opts.params` rather than from `sampling`: the ceiling keys off
  // the reasoning level, which the destructure above just removed.
  const ceiling = recommendedOutputCeiling(model, opts.params ?? {})
  return new OpenAIProvider(model, {
    params: sampling,
    ...(ceiling === undefined ? {} : { maxOutputTokens: ceiling }),
    baseURL: OPENROUTER_BASE_URL,
    apiKey,
    includeUsage: true,
    defaultHeaders: OPENROUTER_ATTRIBUTION_HEADERS,
    extraBody: {
      provider: {
        require_parameters: true,
        ...(zdrOnly ? { zdr: true } : {}),
        ...(allowTraining ? {} : { data_collection: 'deny' }),
      },
      ...openRouterReasoningBody(opts.params ?? {}),
    },
    ...(promptCacheKey ? { promptCacheKey } : {}),
  })
}

// An extra provider (built-in preset or user-added custom) is OpenAI-compatible,
// so it reuses OpenAIProvider with the provider's base URL. `model` is the
// upstream id with the provider slug already stripped. `includeUsage` defaults
// on for billed cloud APIs and off for a localhost server (which rarely reports
// usage); `extraBody` carries any provider-specific request fields (e.g. an
// OpenRouter-style routing hint a user pastes into the advanced field).
//
// `approvedHosts` is the user-approved custom-provider host list (issue #438).
// Built-in / loopback hosts pass without it; an unapproved custom host throws
// before the SDK client is constructed so no key or prompt is sent.
export function createExtraCloudProvider(
  provider: ExtraProvider,
  model: string,
  apiKey: string,
  approvedHosts: readonly string[] = [],
  params: ModelParameters = {},
): LLMProvider {
  validateCredentialBaseUrl(provider.baseUrl, 'Provider base URL')
  assertProviderHostAllowed(provider.baseUrl, approvedHosts)
  if (provider.apiStyle === 'responses') {
    // No output ceiling on this transport: the cards we hold were written
    // against Chat Completions endpoints, and this path has no drop-and-retry
    // for a ceiling the server rejects. The server's own default stands.
    const { tools, ...extraBody } = provider.extraBody ?? {}
    const serverTools = Array.isArray(tools) ? tools.filter(isWebSearchTool) : []
    return new ResponsesProvider(model, {
      baseURL: provider.baseUrl,
      apiKey,
      serverTools,
      params,
      ...(Object.keys(extraBody).length ? { extraBody } : {}),
    })
  }
  const ceiling = recommendedOutputCeiling(model, params)
  return new OpenAIProvider(model, {
    baseURL: provider.baseUrl,
    // Local servers usually run without auth but still want a non-empty key
    // (many reject a blank Authorization header), mirroring createLocalOpenAIProvider.
    apiKey: provider.local ? apiKey || 'lm-studio' : apiKey,
    includeUsage: provider.includeUsage ?? !provider.local,
    params,
    ...(ceiling === undefined ? {} : { maxOutputTokens: ceiling }),
    ...(provider.extraBody ? { extraBody: provider.extraBody } : {}),
  })
}
