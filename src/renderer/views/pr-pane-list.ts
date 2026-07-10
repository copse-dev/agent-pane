import type { GhPrSummary } from '@shared/types/git.ts'
import { githubPrKey } from '@shared/git/github-pr-url.ts'

/** A pull request identified only by repo + number (e.g. parsed from chat). */
export interface PrRef {
  owner: string
  repo: string
  number: number
}

/**
 * Synthetic title for a chat-linked PR we couldn't enrich from a listing —
 * cross-repo, or closed/merged so it's absent from the open-PR pools. The row's
 * number column already shows `#<n>`, so this stands in only until (if ever) a
 * real title is known.
 */
export function placeholderPrTitle(number: number): string {
  return `PR #${String(number)}`
}

/** Whether `pr` carries only the synthetic placeholder title, not a real one. */
export function isPlaceholderPr(pr: GhPrSummary): boolean {
  return pr.title === placeholderPrTitle(pr.number)
}

/**
 * Text shown in a list row's title slot. An unenriched PR's placeholder title
 * just restates the `#<n>` number column beside it, so show the source repo
 * instead — real context for cross-repo references, and no duplication.
 */
export function prListDisplayTitle(pr: GhPrSummary): string {
  return isPlaceholderPr(pr) ? `${pr.owner}/${pr.repo}` : pr.title
}

/**
 * Merge chat-linked refs with fetched PR pools into one de-duplicated list.
 * Linked refs lead (enriched from the pools when present, else a placeholder
 * summary); remaining pool PRs follow in order.
 */
export function mergePrLists(linked: PrRef[], pools: GhPrSummary[][]): GhPrSummary[] {
  const seen = new Set<string>()
  const merged: GhPrSummary[] = []
  const known = pools.flat()
  for (const ref of linked) {
    const key = githubPrKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    const fromPools = known.find(
      (pr) => pr.owner === ref.owner && pr.repo === ref.repo && pr.number === ref.number,
    )
    merged.push(
      fromPools ?? {
        ...ref,
        title: placeholderPrTitle(ref.number),
        url: `https://github.com/${ref.owner}/${ref.repo}/pull/${String(ref.number)}`,
        state: 'OPEN',
      },
    )
  }
  for (const pool of pools) {
    for (const pr of pool) {
      const key = githubPrKey(pr)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(pr)
    }
  }
  return merged
}
