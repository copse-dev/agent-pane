import { resolveWebSearchProvider, WEB_SEARCH_ENDPOINTS } from '@shared/web-search.ts'
import { getSetting, resolveApiKey } from '../storage/settings.ts'
import { requestParallelSearch } from '../parallel-search.ts'
import {
  assertWebOriginAllowed,
  clearWebOriginGrant,
  webAllowedOriginsWithDefaults,
  webOriginKey,
  WEB_ALLOWED_ORIGINS_SETTING,
} from '../security/web-origin-policy.ts'
import { requestTavilySearch } from './tavily.ts'
import type { WebHit } from './types.ts'

export function getWebSearchProvider(): ReturnType<typeof resolveWebSearchProvider> {
  return resolveWebSearchProvider(getSetting('webSearchProvider', 'none'))
}

export async function webSearch(
  query: string,
  limit = 10,
  signal: AbortSignal = new AbortController().signal,
): Promise<WebHit[]> {
  const provider = getWebSearchProvider()
  if (provider === 'none') {
    throw new Error('Web search is not configured. Select a provider in Settings → Web search.')
  }
  const endpoint = new URL(WEB_SEARCH_ENDPOINTS[provider])
  try {
    const apiKey = resolveApiKey(provider)
    if (!apiKey) {
      throw new Error(
        `Add a ${provider === 'tavily' ? 'Tavily' : 'Parallel'} API key in Settings → Web search.`,
      )
    }
    assertWebOriginAllowed(
      endpoint,
      webAllowedOriginsWithDefaults(getSetting<string[] | null>(WEB_ALLOWED_ORIGINS_SETTING, null)),
    )
    if (provider === 'tavily') return await requestTavilySearch(apiKey, query, limit, signal)
    const response = await requestParallelSearch(
      apiKey,
      { objective: query, searchQueries: [query], mode: 'basic' },
      signal,
    )
    return response.results.slice(0, limit).map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.excerpts?.join('\n\n') ?? '',
    }))
  } finally {
    clearWebOriginGrant(webOriginKey(endpoint))
  }
}
