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
} from '@shared/llm/extra-providers.ts'
import { providerSlugFromBaseUrl, uniqueProviderSlug } from '@shared/llm/provider-slug.ts'
import { getSetting, setSetting, deleteApiKey } from './settings.ts'

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
export async function deleteExtraProvider(slug: string): Promise<ExtraProvider[]> {
  const current = storedProviders()
  const list = current.filter((p) => p.slug !== slug)
  await setSetting('extraProviders', list)
  if (!BUILTIN_EXTRA_PROVIDER_SLUGS.includes(slug)) deleteApiKey(slug)
  return resolveExtraProviders(list)
}
