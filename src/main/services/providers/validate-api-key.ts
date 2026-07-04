import { FETCH_TIMEOUTS } from '../fetch-timeouts.ts'
import type { ExtraProvider } from '@shared/llm/extra-providers.ts'
import { getResolvedExtraProvider } from './extra-providers-store.ts'
import { getSetting } from '../storage/settings.ts'
import { OPENROUTER_BASE_URL } from '@shared/llm/openrouter.ts'

// Same overridable base the model catalog fetch uses (openrouter-models.ts): the
// hidden `openRouterApiBase` setting lets e2e point validation at a local
// fixture, while production resolves to OpenRouter's public API. Keeping both
// paths on one base means gating the picker on validation can't diverge from
// where the catalog is actually fetched.
function openRouterApiBase(): string {
  return getSetting<string>('openRouterApiBase', OPENROUTER_BASE_URL).replace(/\/$/, '')
}

export interface ApiKeyValidationResult {
  ok: boolean
  error?: string
  /** Key matches the provider’s expected prefix before any network call. */
  formatOk?: boolean
}

const ANTHROPIC_KEY_RE = /^sk-ant-/
const OPENAI_KEY_RE = /^sk-/
const OPENROUTER_KEY_RE = /^sk-or-/

function formatError(provider: 'anthropic' | 'openai'): string {
  return provider === 'anthropic' ? 'Key should start with sk-ant-' : 'Key should start with sk-'
}

export async function validateAnthropicApiKey(key: string): Promise<ApiKeyValidationResult> {
  const trimmed = key.trim()
  if (!trimmed) return { ok: false, error: 'Key is empty' }
  if (!ANTHROPIC_KEY_RE.test(trimmed)) {
    return { ok: false, error: formatError('anthropic'), formatOk: false }
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': trimmed,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.apiKeyValidation),
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Key rejected by Anthropic', formatOk: true }
    }
    if (!res.ok) {
      return { ok: false, error: `Anthropic returned HTTP ${String(res.status)}`, formatOk: true }
    }
    return { ok: true, formatOk: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not reach Anthropic',
      formatOk: true,
    }
  }
}

export async function validateOpenAiApiKey(key: string): Promise<ApiKeyValidationResult> {
  const trimmed = key.trim()
  if (!trimmed) return { ok: false, error: 'Key is empty' }
  if (!OPENAI_KEY_RE.test(trimmed)) {
    return { ok: false, error: formatError('openai'), formatOk: false }
  }

  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${trimmed}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.apiKeyValidation),
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Key rejected by OpenAI', formatOk: true }
    }
    if (!res.ok) {
      return { ok: false, error: `OpenAI returned HTTP ${String(res.status)}`, formatOk: true }
    }
    return { ok: true, formatOk: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not reach OpenAI',
      formatOk: true,
    }
  }
}

function cursorAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`
}

export async function validateCursorApiKey(key: string): Promise<ApiKeyValidationResult> {
  const trimmed = key.trim()
  if (!trimmed) return { ok: false, error: 'Key is empty' }

  try {
    const res = await fetch('https://api.cursor.com/v1/models', {
      headers: { Authorization: cursorAuthHeader(trimmed) },
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.apiKeyValidation),
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Key rejected by Cursor', formatOk: true }
    }
    if (!res.ok) {
      return { ok: false, error: `Cursor returned HTTP ${String(res.status)}`, formatOk: true }
    }
    return { ok: true, formatOk: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not reach Cursor',
      formatOk: true,
    }
  }
}

export async function validateOpenRouterApiKey(key: string): Promise<ApiKeyValidationResult> {
  const trimmed = key.trim()
  if (!trimmed) return { ok: false, error: 'Key is empty' }
  if (!OPENROUTER_KEY_RE.test(trimmed)) {
    return { ok: false, error: 'Key should start with sk-or-', formatOk: false }
  }

  try {
    // `/key` echoes the key's own metadata and requires auth, so it doubles as a
    // free auth check without spending any credits.
    const res = await fetch(`${openRouterApiBase()}/key`, {
      headers: { Authorization: `Bearer ${trimmed}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.apiKeyValidation),
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Key rejected by OpenRouter', formatOk: true }
    }
    if (!res.ok) {
      return { ok: false, error: `OpenRouter returned HTTP ${String(res.status)}`, formatOk: true }
    }
    return { ok: true, formatOk: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not reach OpenRouter',
      formatOk: true,
    }
  }
}

// Every extra provider is OpenAI-compatible, so a GET on its `/models` endpoint
// with the key as a Bearer token doubles as a free auth check.
export async function validateExtraProviderApiKey(
  provider: Pick<ExtraProvider, 'baseUrl' | 'label' | 'keyPrefix'>,
  key: string,
): Promise<ApiKeyValidationResult> {
  const trimmed = key.trim()
  if (!trimmed) return { ok: false, error: 'Key is empty' }
  if (provider.keyPrefix && !trimmed.startsWith(provider.keyPrefix)) {
    return { ok: false, error: `Key should start with ${provider.keyPrefix}`, formatOk: false }
  }

  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${trimmed}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.apiKeyValidation),
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `Key rejected by ${provider.label}`, formatOk: true }
    }
    if (!res.ok) {
      return {
        ok: false,
        error: `${provider.label} returned HTTP ${String(res.status)}`,
        formatOk: true,
      }
    }
    return { ok: true, formatOk: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : `Could not reach ${provider.label}`,
      formatOk: true,
    }
  }
}

// The fixed cloud providers have bespoke validation; everything else is treated
// as an extra provider slug and validated against its own base URL.
export type ValidatableProvider = string

export async function validateApiKey(
  provider: ValidatableProvider,
  key: string,
): Promise<ApiKeyValidationResult> {
  if (provider === 'anthropic') return validateAnthropicApiKey(key)
  if (provider === 'openai') return validateOpenAiApiKey(key)
  if (provider === 'cursor') return validateCursorApiKey(key)
  if (provider === 'openrouter') return validateOpenRouterApiKey(key)
  const extra = getResolvedExtraProvider(provider)
  if (extra) return validateExtraProviderApiKey(extra, key)
  return { ok: false, error: `Unknown provider '${provider}'` }
}
