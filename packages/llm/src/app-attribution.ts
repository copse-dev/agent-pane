// App-attribution request headers.
//
// `HTTP-Referer` + `X-Title` began as OpenRouter's way for a client to name
// itself, and OpenAI-compatible routers copied the pair as a de facto
// convention: OpenRouter drives its public app rankings and app pages from it,
// Vercel AI Gateway and Requesty read it for dashboard attribution, and
// providers that know neither header ignore both. Copse therefore sends the
// pair on every provider request rather than special-casing one aggregator.
//
// OpenRouter has since renamed its title header to `X-OpenRouter-Title` while
// still accepting `X-Title`. Rather than depend on which one wins when both are
// present, `openRouterAttributionHeaders` sends both with the *same* value, so
// the precedence question cannot change what OpenRouter records.
//
// These headers identify the application, never the user: no key, account,
// machine or thread identifier is derived from them, and the values are the
// same fixed constants in every install. On OpenRouter the app name is public
// (it appears in the rankings); everywhere else it is ordinary request
// metadata. See docs/privacy-data-flow.md.

/** Public product URL used as the attribution referer. */
export const APP_ATTRIBUTION_URL = 'https://copse.dev/'

/** Product name as it should appear in a router's attribution UI. */
export const APP_ATTRIBUTION_TITLE = 'Copse'

/**
 * The cross-router attribution pair, sent to every provider (cloud, custom, and
 * local OpenAI-compatible servers alike).
 */
export const APP_ATTRIBUTION_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'HTTP-Referer': APP_ATTRIBUTION_URL,
  'X-Title': APP_ATTRIBUTION_TITLE,
})

/**
 * OpenRouter's variant: the common pair plus OpenRouter's current title header
 * name, all carrying the same title.
 */
export const OPENROUTER_ATTRIBUTION_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  ...APP_ATTRIBUTION_HEADERS,
  'X-OpenRouter-Title': APP_ATTRIBUTION_TITLE,
})

/**
 * Merge caller-supplied default headers over the attribution pair. Caller
 * headers win, so a provider-specific header (or a future user override) can
 * replace an attribution value rather than being shadowed by it.
 */
export function withAppAttribution(
  headers?: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...APP_ATTRIBUTION_HEADERS, ...headers }
}
