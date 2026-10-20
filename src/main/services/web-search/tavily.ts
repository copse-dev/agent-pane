import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'
import { WEB_SEARCH_ENDPOINTS } from '@shared/web-search.ts'
import { readWebResponseText } from '../security/web-origin-policy.ts'
import type { WebHit } from './types.ts'

const responseSchema = z.object({
  results: z.array(z.object({ title: z.string(), url: z.url(), content: z.string() })),
})

export async function requestTavilySearch(
  apiKey: string,
  query: string,
  limit: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<WebHit[]> {
  const response = await fetchImpl(WEB_SEARCH_ENDPOINTS.tavily, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: Math.min(limit, 20),
      include_answer: false,
      include_raw_content: false,
      auto_parameters: false,
    }),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Tavily rejected the API key. Update it in Settings → Web search.')
    }
    if (response.status === 402 || response.status === 432 || response.status === 433) {
      throw new Error('Tavily search credits are exhausted. Check your Tavily account limits.')
    }
    if (response.status === 429)
      throw new Error('Tavily Search rate limit exceeded. Try again later.')
    throw new Error(`Tavily Search returned HTTP ${String(response.status)}.`)
  }
  const parsed = safeJsonParse(
    await readWebResponseText(response),
    decodeWithSchema(responseSchema),
  )
  if (!parsed) throw new Error('Tavily Search returned an unexpected response shape.')
  return parsed.results.slice(0, limit).map((result) => ({
    title: result.title,
    url: result.url,
    snippet: result.content,
  }))
}
