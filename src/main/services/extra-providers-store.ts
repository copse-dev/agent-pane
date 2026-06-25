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
 * Persist (insert or replace) one provider record. For a built-in slug this is
 * an override; for any other slug it is a user custom. Returns the resolved
 * list so the caller can hand it straight back to the renderer.
 *
 * If `record.slug` is blank, a slug is derived from the base URL and made unique
 * against reserved built-ins and existing customs. A custom slug that collides
 * with a built-in is rejected back onto the built-in override path is NOT done
 * here — callers should present the built-in row instead.
 */
export async function saveExtraProvider(
  record: Omit<StoredExtraProvider, 'slug'> & { slug?: string },
): Promise<ExtraProvider[]> {
  const current = storedProviders()
  const givenSlug = (record.slug ?? '').trim()
  const isBuiltin = !!givenSlug && BUILTIN_EXTRA_PROVIDER_SLUGS.includes(givenSlug)

  let slug = givenSlug
  if (!isBuiltin) {
    const takenCustomSlugs = current
      .filter((p) => !BUILTIN_EXTRA_PROVIDER_SLUGS.includes(p.slug) && p.slug !== record.slug)
      .map((p) => p.slug)
    if (!slug) slug = providerSlugFromBaseUrl(record.baseUrl ?? '')
    // Freeze the slug: only disambiguate when it isn't already this record's slug.
    if (!current.some((p) => p.slug === slug)) {
      slug = uniqueProviderSlug(slug, takenCustomSlugs)
    }
  }

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
