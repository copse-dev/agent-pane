import { search as ddgSearch } from 'ddg-search'
import type { WebHit } from './types.ts'

export const DDG_BLOCKED_HELP =
  'DuckDuckGo blocked this search — their anti-bot system often flags automated requests after only a few searches from the same IP. Wait a minute and try again, or use fetch_url on a known documentation URL instead.'

const silentStderr = { write: () => true, isTTY: false }

/** Decode DuckDuckGo redirect links (uddg=...) to the destination URL. */
export function decodeDdgRedirectUrl(href: string): string {
  const absolute = href.startsWith('//') ? `https:${href}` : href
  try {
    const parsed = new URL(absolute)
    const uddg = parsed.searchParams.get('uddg')
    if (uddg) return decodeURIComponent(uddg)
    return parsed.toString()
  } catch {
    return href
  }
}

function isDdgBlockedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes('Anti-bot detection')
}

export async function webSearch(query: string, limit = 10): Promise<WebHit[]> {
  try {
    const response = await ddgSearch(query, {
      maxPages: 1,
      maxResults: limit,
      region: '',
      time: '',
      stderr: silentStderr,
    })

    return response.results
      .map((result) => ({
        title: result.title,
        url: decodeDdgRedirectUrl(result.url),
        snippet: result.description,
      }))
      .filter((hit) => hit.url.length > 0)
  } catch (error) {
    if (isDdgBlockedError(error)) throw new Error(DDG_BLOCKED_HELP, { cause: error })
    throw error
  }
}
