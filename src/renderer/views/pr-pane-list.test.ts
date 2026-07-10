import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GhPrSummary } from '@shared/types/git.ts'
import {
  isPlaceholderPr,
  mergePrLists,
  placeholderPrTitle,
  prListDisplayTitle,
  type PrRef,
} from './pr-pane-list.ts'

function summary(
  overrides: Partial<GhPrSummary> & Pick<GhPrSummary, 'owner' | 'repo' | 'number'>,
): GhPrSummary {
  return {
    title: `PR ${String(overrides.number)}`,
    url: `https://github.com/${overrides.owner}/${overrides.repo}/pull/${String(overrides.number)}`,
    state: 'OPEN',
    ...overrides,
  }
}

test('isPlaceholderPr detects only the synthetic title', () => {
  const placeholder = summary({ owner: 'o', repo: 'r', number: 42, title: placeholderPrTitle(42) })
  const enriched = summary({ owner: 'o', repo: 'r', number: 42, title: 'Add a real feature' })
  assert.equal(isPlaceholderPr(placeholder), true)
  assert.equal(isPlaceholderPr(enriched), false)
  // A real title that merely mentions another PR number must not be mistaken
  // for the placeholder — the match is against this PR's own number.
  const decoy = summary({ owner: 'o', repo: 'r', number: 42, title: 'PR #7' })
  assert.equal(isPlaceholderPr(decoy), false)
})

test('prListDisplayTitle shows the repo slug only for placeholders', () => {
  const placeholder = summary({
    owner: 'duckduckgo',
    repo: 'content-scope-scripts',
    number: 2848,
    title: placeholderPrTitle(2848),
  })
  const enriched = summary({ owner: 'o', repo: 'r', number: 42, title: 'Add GitHub PR panel tab' })
  // The `#2848` number column already carries the number, so the placeholder row
  // shows the source repo rather than restating `PR #2848`.
  assert.equal(prListDisplayTitle(placeholder), 'duckduckgo/content-scope-scripts')
  assert.equal(prListDisplayTitle(enriched), 'Add GitHub PR panel tab')
})

test('mergePrLists enriches linked refs from pools and placeholders the rest', () => {
  const linked: PrRef[] = [
    { owner: 'o', repo: 'r', number: 42 }, // present in the pool → enriched
    { owner: 'duckduckgo', repo: 'content-scope-scripts', number: 2848 }, // cross-repo → placeholder
  ]
  const workspacePool = [
    summary({ owner: 'o', repo: 'r', number: 42, title: 'Add GitHub PR panel tab' }),
    summary({ owner: 'o', repo: 'r', number: 88, title: 'Tidy up polling' }),
  ]

  const merged = mergePrLists(linked, [workspacePool])

  // Linked refs lead, in order: the pooled one keeps its real title, the
  // cross-repo one gets a placeholder that renders as its repo slug.
  assert.deepEqual(
    merged.map((pr) => [pr.number, prListDisplayTitle(pr)]),
    [
      [42, 'Add GitHub PR panel tab'],
      [2848, 'duckduckgo/content-scope-scripts'],
      [88, 'Tidy up polling'],
    ],
  )
  // #42 appears once despite being both linked and pooled.
  assert.equal(merged.filter((pr) => pr.number === 42).length, 1)
})
