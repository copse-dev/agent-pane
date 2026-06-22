import { JSDOM } from 'jsdom'
import type { WebHit } from './types.ts'

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const BASE_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
}

export const DDG_BLOCKED_HELP =
  'DuckDuckGo blocked this search — their anti-bot system often flags automated requests after only a few searches from the same IP. Wait a minute and try again, or use fetch_url on a known documentation URL instead.'

const MIN_SEARCH_GAP_MS = 2500
const RETRY_DELAY_MS = 8000

let lastSearchAt = 0

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

function stripInlineHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse DuckDuckGo HTML lite results into web hits. */
export function parseDdgHtmlResults(html: string, limit: number): WebHit[] {
  const dom = new JSDOM(html)
  const hits: WebHit[] = []

  for (const result of dom.window.document.querySelectorAll('.result')) {
    const link = result.querySelector('a.result__a')
    if (!link) continue

    const href = link.getAttribute('href') ?? ''
    const url = decodeDdgRedirectUrl(href)
    if (!url) continue

    const snippetEl = result.querySelector('a.result__snippet, .result__snippet')
    hits.push({
      title: stripInlineHtml(link.innerHTML),
      url,
      snippet: snippetEl ? stripInlineHtml(snippetEl.innerHTML) : '',
    })

    if (hits.length >= limit) break
  }

  return hits
}

function isDdgBlocked(status: number, html: string): boolean {
  return (
    status === 202 || html.includes('DDG.deep.anomalyDetectionBlock') || html.includes('anomaly.js')
  )
}

async function fetchDdgHtml(query: string): Promise<{ status: number; html: string }> {
  const url = `${DDG_HTML_URL}?q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: BASE_HEADERS })
  const html = await res.text()
  return { status: res.status, html }
}

export async function webSearch(query: string, limit = 10): Promise<WebHit[]> {
  const now = Date.now()
  const waitMs = MIN_SEARCH_GAP_MS - (now - lastSearchAt)
  if (waitMs > 0) await sleep(waitMs)

  let { status, html } = await fetchDdgHtml(query)
  lastSearchAt = Date.now()

  if (isDdgBlocked(status, html)) {
    await sleep(RETRY_DELAY_MS)
    lastSearchAt = Date.now()
    const retry = await fetchDdgHtml(query)
    status = retry.status
    html = retry.html
  }

  if (isDdgBlocked(status, html)) throw new Error(DDG_BLOCKED_HELP)

  return parseDdgHtmlResults(html, limit)
}
