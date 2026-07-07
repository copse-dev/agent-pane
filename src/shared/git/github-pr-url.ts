export interface GithubPrRef {
  owner: string
  repo: string
  number: number
  url: string
}

// Accept a trailing path after the PR number (`/files`, `/commits`, a trailing
// slash) so a link to a PR sub-tab still resolves to the PR itself.
const GITHUB_PR_PATH_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/[^?#]*)?$/i

/** Parse a GitHub pull request URL into owner, repo, and number. */
export function parseGithubPrUrl(rawUrl: string): GithubPrRef | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.hostname.replace(/^www\./i, '').toLowerCase() !== 'github.com') return null
    const match = url.pathname.match(GITHUB_PR_PATH_RE)
    if (!match) return null
    const [, ownerGroup, repoGroup, numberGroup] = match
    if (ownerGroup === undefined || repoGroup === undefined || numberGroup === undefined) {
      return null
    }
    const owner = ownerGroup
    const repo = repoGroup.replace(/\.git$/i, '')
    const number = Number.parseInt(numberGroup, 10)
    if (!Number.isFinite(number) || number <= 0) return null
    return { owner, repo, number, url: trimmed }
  } catch {
    return null
  }
}

const GITHUB_PR_URL_RE =
  /https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+(?:[^\s)\]>]*)/gi

/** Collect unique GitHub PR URLs from free-form text (e.g. chat messages). */
export function extractGithubPrUrls(text: string): GithubPrRef[] {
  const seen = new Set<string>()
  const refs: GithubPrRef[] = []
  for (const match of text.matchAll(GITHUB_PR_URL_RE)) {
    const raw = match[0].replace(/[.,;:)\]>]+$/, '')
    const parsed = parseGithubPrUrl(raw)
    if (!parsed) continue
    const key = `${parsed.owner}/${parsed.repo}#${String(parsed.number)}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(parsed)
  }
  return refs
}

/** Stable key for deduplicating PR references across the UI. */
export function githubPrKey(ref: Pick<GithubPrRef, 'owner' | 'repo' | 'number'>): string {
  return `${ref.owner}/${ref.repo}#${String(ref.number)}`
}
