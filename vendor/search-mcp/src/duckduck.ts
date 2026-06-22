import { search } from 'duck-duck-scrape'
import type { WebHit } from './types.ts'

export async function webSearch(query: string, limit = 10): Promise<WebHit[]> {
  const { results } = await search(query, { safeSearch: 0 })
  return results.slice(0, limit).map((result) => ({
    title: result.title,
    url: result.url,
    snippet: result.description,
  }))
}
