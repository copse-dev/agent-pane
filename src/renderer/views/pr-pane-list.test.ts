import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GhPrSummary } from '@shared/types/git.ts'
import {
  isPlaceholderPr,
  mergePrLists,
  placeholderPrTitle,
  prListDisplayTitle,
  prMatchesFilter,
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

test('prMatchesFilter: empty/whitespace query matches everything', () => {
  const pr = summary({ owner: 'o', repo: 'r', number: 42, title: 'Add a real feature' })
  assert.equal(prMatchesFilter(pr, ''), true)
  assert.equal(prMatchesFilter(pr, '   '), true)
})

test('prMatchesFilter: matches PR number with or without a leading #', () => {
  const pr = summary({ owner: 'o', repo: 'r', number: 123, title: 'Unrelated title' })
  assert.equal(prMatchesFilter(pr, '123'), true)
  assert.equal(prMatchesFilter(pr, '#123'), true)
  assert.equal(prMatchesFilter(pr, '12'), true) // substring match
  assert.equal(prMatchesFilter(pr, '#124'), false)
  assert.equal(prMatchesFilter(pr, '456'), false)
})

test('prMatchesFilter: matches title, head branch, and author login case-insensitively', () => {
  const pr = summary({
    owner: 'o',
    repo: 'r',
    number: 7,
    title: 'Fix the Filter Bug',
    headRefName: 'jonathan/pr-filter',
    authorLogin: 'JooperCo',
  })
  assert.equal(prMatchesFilter(pr, 'filter bug'), true)
  assert.equal(prMatchesFilter(pr, 'FILTER'), true)
  assert.equal(prMatchesFilter(pr, 'pr-filter'), true)
  assert.equal(prMatchesFilter(pr, 'jonathan'), true)
  assert.equal(prMatchesFilter(pr, 'jooperco'), true)
  assert.equal(prMatchesFilter(pr, 'nonexistent'), false)
})

test('prMatchesFilter: a PR missing headRefName/authorLogin never matches on them', () => {
  const pr = summary({ owner: 'o', repo: 'r', number: 9, title: 'No branch info' })
  assert.equal(prMatchesFilter(pr, 'undefined'), false)
  assert.equal(prMatchesFilter(pr, 'no branch'), true)
})

test('mergePrLists enriches a linked ref whose repository casing differs from the pool', () => {
  const merged = mergePrLists(
    [{ owner: 'Copse-Dev', repo: 'Copse-Panel', number: 42 }],
    [
      [
        summary({
          owner: 'copse-dev',
          repo: 'copse-panel',
          number: 42,
          title: 'Add GitHub PR panel tab',
        }),
      ],
    ],
  )

  assert.equal(merged.length, 1)
  assert.equal(merged[0]?.title, 'Add GitHub PR panel tab')
})
