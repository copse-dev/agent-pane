import { githubPrKey, type GithubPrRef } from '@shared/git/github-pr-url.ts'
import type { ApiClient } from '../../preload/api.d.ts'

type PrRef = Pick<GithubPrRef, 'owner' | 'repo' | 'number'>

export interface CachedPrTitle {
  title: string
  isDraft?: boolean
}

const MAX_TITLES = 128
const titles = new Map<string, CachedPrTitle>()
const inFlight = new Map<string, Promise<CachedPrTitle | null>>()

export function cachedPrTitle(ref: PrRef): CachedPrTitle | undefined {
  return titles.get(githubPrKey(ref))
}

/** Share titles learned from PR listings, details, and chat-link hovers. */
export function rememberPrTitle(ref: PrRef, title: string, isDraft?: boolean): void {
  const trimmed = title.trim()
  if (!trimmed || trimmed === `PR #${String(ref.number)}`) return
  const key = githubPrKey(ref)
  const previous = titles.get(key)
  titles.delete(key)
  titles.set(key, {
    title: trimmed,
    ...(isDraft !== undefined
      ? { isDraft }
      : previous?.isDraft !== undefined
        ? { isDraft: previous.isDraft }
        : {}),
  })
  if (titles.size > MAX_TITLES) {
    const oldest = titles.keys().next().value
    if (oldest !== undefined) titles.delete(oldest)
  }
}

/** One details request per PR even when a pane and a hovered link ask together. */
export function loadPrTitle(
  ref: PrRef,
  gh: Pick<ApiClient['gh'], 'prDetails'>,
): Promise<CachedPrTitle | null> {
  const cached = cachedPrTitle(ref)
  if (cached) return Promise.resolve(cached)
  const key = githubPrKey(ref)
  const pending = inFlight.get(key)
  if (pending) return pending

  const request = gh
    .prDetails(ref.owner, ref.repo, ref.number)
    .then((details) => {
      if (!details) return null
      rememberPrTitle(ref, details.title, details.isDraft)
      return cachedPrTitle(ref) ?? null
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, request)
  return request
}
