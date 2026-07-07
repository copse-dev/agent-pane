// Main-process accessors for the user's OpenAI-compatible "extra" providers.
// The editable layer (preset overrides + user customs) is persisted under the
// `extraProviders` setting; the effective list is that merged with the shipped
// presets via `resolveExtraProviders`. Consumers (provider-selection,
// resolve-context-window, validate-api-key, IPC) read fresh each call so a
// provider added mid-session is picked up without a restart.

import {
  resolveExtraProviders,
  BUILTIN_EXTRA_PROVIDER_SLUGS,
  type ExtraProvider,
  type StoredExtraProvider,
} from '@copse/llm/extra-providers.ts'
import { providerSlugFromBaseUrl, uniqueProviderSlug } from '@copse/llm/provider-slug.ts'
import { getSetting, setSetting, deleteApiKey, resolveApiKey } from '../storage/settings.ts'
import { fetchHuggingFaceModels } from './huggingface-models.ts'

/** Built-in slug of the Hugging Face Inference Providers provider. */
export const HUGGINGFACE_SLUG = 'huggingface'

function storedProviders(): StoredExtraProvider[] {
  const raw = getSetting<StoredExtraProvider[]>('extraProviders', [])
  return Array.isArray(raw) ? raw : []
}

/** The effective provider list: shipped presets merged with stored overrides/customs. */
export function getResolvedExtraProviders(): ExtraProvider[] {
  return resolveExtraProviders(storedProviders())
}

/** Find one resolved provider by slug, or null. */
export function getResolvedExtraProvider(slug: string): ExtraProvider | null {
  return getResolvedExtraProviders().find((p) => p.id === slug) ?? null
}

/**
 * Persist (insert or replace) one provider record. A built-in slug is an
 * override; any other slug is a user custom. Returns the resolved list so the
 * caller can hand it straight back to the renderer.
 *
 * Slug handling encodes the "frozen slug" rule:
 *   - An explicit slug (an edit, or a user-typed one) is used verbatim, so it
 *     replaces the matching record and never drifts when the URL changes.
 *   - A blank slug (a fresh add) is derived from the base URL and disambiguated
 *     against reserved built-ins and existing customs, so two providers on the
 *     same host stay distinct instead of clobbering each other.
 */
export async function saveExtraProvider(
  record: Omit<StoredExtraProvider, 'slug'> & { slug?: string },
): Promise<ExtraProvider[]> {
  const current = storedProviders()
  const givenSlug = (record.slug ?? '').trim()

  const slug = givenSlug
    ? givenSlug
    : uniqueProviderSlug(
        providerSlugFromBaseUrl(record.baseUrl ?? ''),
        current.map((p) => p.slug),
      )

  const next: StoredExtraProvider = { ...record, slug }
  const idx = current.findIndex((p) => p.slug === slug)
  const list = idx >= 0 ? current.map((p) => (p.slug === slug ? next : p)) : [...current, next]
  await setSetting('extraProviders', list)
  return resolveExtraProviders(list)
}

/**
 * Remove a provider. For a user custom this drops the record and its stored key.
 * For a built-in this drops the override (reverting it to the shipped defaults)
 * but leaves the key in place. Returns the resolved list.
 */
/**
 * Fetch the Hugging Face router catalogue with the stored (or env) HF token and
 * persist the resolved, priced, provider-pinned models onto the `huggingface`
 * provider. Called automatically when the HF token is saved, and on demand from
 * the Settings "Fetch models" action. A blank token or failed fetch leaves the
 * stored models untouched and reports the error.
 */
export async function refreshHuggingFaceModels(
  apiKey?: string,
): Promise<{ ok: boolean; count: number; error?: string }> {
  const key = apiKey?.trim() || resolveApiKey(HUGGINGFACE_SLUG) || ''
  const res = await fetchHuggingFaceModels(key)
  if (!res.ok) return { ok: false, count: 0, ...(res.error ? { error: res.error } : {}) }
  await saveExtraProvider({ slug: HUGGINGFACE_SLUG, models: res.models })
  return { ok: true, count: res.models.length }
}

export async function deleteExtraProvider(slug: string): Promise<ExtraProvider[]> {
  const current = storedProviders()
  const list = current.filter((p) => p.slug !== slug)
  await setSetting('extraProviders', list)
  if (!BUILTIN_EXTRA_PROVIDER_SLUGS.includes(slug)) deleteApiKey(slug)
  return resolveExtraProviders(list)
}
