/**
 * Extract external links referenced by a skill's markdown.
 *
 * A skill's SKILL.md is plain instructions injected into the agent's context, but
 * it can point the agent at the network — markdown links, autolinks, or bare
 * URLs that say "fetch this", "install from here", or "run this script". Those
 * are an exfiltration / supply-chain surface, so we surface them to the user
 * up front (and to the model as a caution) before the skill runs.
 *
 * Only `http(s)` URLs are treated as external. `mailto:`, `file:`, relative
 * paths, and in-repo references are ignored — they don't reach the network.
 * Results are de-duplicated by hostname (lower-cased) and sorted, since the
 * point is "which third parties does this skill reach", not every URL variant.
 */

// Match http/https URLs. The trailing class stops at whitespace and the
// punctuation that typically closes a markdown link, autolink, or sentence so a
// `](https://example.com)` or `<https://example.com>` doesn't capture the
// bracket. A pragmatic heuristic, not a full URL grammar.
const URL_RE = /\bhttps?:\/\/[^\s)>\]}"'`]+/gi

/** Strip trailing sentence punctuation the URL regex may have swept up. */
function trimTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/, '')
}

/** Unique external hostnames referenced by `http(s)` URLs in the text, sorted. */
export function extractExternalLinkHosts(text: string): string[] {
  const hosts = new Set<string>()
  for (const match of text.matchAll(URL_RE)) {
    try {
      const { hostname } = new URL(trimTrailingPunctuation(match[0]))
      if (hostname) hosts.add(hostname.toLowerCase())
    } catch {
      // Not a parseable URL — ignore.
    }
  }
  return [...hosts].sort()
}
