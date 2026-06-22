import { parse as parsePublicSuffix } from 'tldts'

const DUCKDUCKGO_SEARCH_ORIGIN = 'https://duckduckgo.com/'

function duckDuckGoSearchUrl(query: string): string {
  const url = new URL(DUCKDUCKGO_SEARCH_ORIGIN)
  url.searchParams.set('q', query)
  return url.href
}

function hasExplicitScheme(input: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(input)
}

function tryParseHttpUrl(input: string): URL | null {
  if (!URL.canParse(input)) return null
  const url = new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url
}

/** True when the hostname looks like a navigable site, not bare search text or a public suffix alone. */
function isNavigableHostname(hostname: string): boolean {
  if (!hostname) return false
  if (hostname === 'localhost') return true

  const parsed = parsePublicSuffix(hostname, { allowPrivateDomains: true })
  if (parsed.isIp) return true
  return parsed.domain != null
}

/** Normalize user-entered text into a URL suitable for navigation. */
export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'about:blank'

  if (hasExplicitScheme(trimmed)) {
    const explicit = tryParseHttpUrl(trimmed)
    if (explicit) return explicit.href
  }

  const candidate = `https://${trimmed}`
  if (URL.canParse(candidate)) {
    const parsed = tryParseHttpUrl(candidate)
    if (parsed && isNavigableHostname(parsed.hostname)) return parsed.href
  }

  return duckDuckGoSearchUrl(trimmed)
}

/** Short label for a browser tab from a loaded URL. */
export function browserTabLabel(url: string, title?: string): string {
  const trimmedTitle = title?.trim()
  if (trimmedTitle && trimmedTitle !== 'about:blank') return trimmedTitle
  if (!url || url === 'about:blank') return 'New tab'
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'about:') return 'New tab'
    return parsed.hostname || url
  } catch {
    return url
  }
}
