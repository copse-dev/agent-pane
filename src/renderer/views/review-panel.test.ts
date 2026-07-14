import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ThreadReview } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { createReviewCardEl } from './review-panel.ts'

// The post-turn review is a subagent: it reads files and its summary prints
// file paths. Those paths must be linkified the same way main-chat assistant
// text is (issue #479 — "Subagent file links aren't clickable"). The shared
// `annotateFileReferences` helper resolves candidates via
// `api.index.resolveFileReferences`, so stub it to mark the printed path as a
// real workspace file.
function fakeApi(
  resolutions: { candidate: string; path: string; kind?: 'file' | 'directory' }[] = [],
): ApiClient {
  return {
    index: {
      resolveFileReferences: async () =>
        resolutions.map((r) => ({ ...r, kind: r.kind ?? ('file' as const) })),
    },
  } as unknown as ApiClient
}

describe('review panel (subagent file links)', () => {
  it('renders the review summary markdown', () => {
    const review: ThreadReview = { status: 'done', summary: 'Looks **good**.' }
    const card = createReviewCardEl(review, fakeApi())
    assert.equal(card.querySelector('.review-panel-body strong')?.textContent, 'good')
  })

  it('does not render a body while the review is still running', () => {
    const review: ThreadReview = { status: 'running', summary: '' }
    const card = createReviewCardEl(review, fakeApi())
    assert.equal(card.querySelector('.review-panel-body'), null)
  })

  it('shows a retry button on a failed review and fires the callback once', () => {
    const review: ThreadReview = { status: 'error', summary: 'Subagent error: model load failed.' }
    let calls = 0
    const card = createReviewCardEl(review, fakeApi(), () => {
      calls++
    })
    const button = card.querySelector<HTMLButtonElement>('.card-retry-button')
    assert.ok(button, 'expected a retry button on the failed review card')
    button.click()
    button.click()
    assert.equal(calls, 1, 'retry fires once then disables itself')
    assert.equal(button.disabled, true)
  })

  it('does not show a retry button on a successful review', () => {
    const review: ThreadReview = { status: 'done', summary: 'Looks good.' }
    const card = createReviewCardEl(review, fakeApi(), () => {})
    assert.equal(card.querySelector('.card-retry-button'), null)
  })

  it('collapses a clean review (issuesFound false) in a details disclosure', () => {
    const review: ThreadReview = {
      status: 'done',
      summary: 'No issues found.',
      issuesFound: false,
    }
    const card = createReviewCardEl(review, fakeApi())
    assert.equal(card.tagName, 'DETAILS')
    assert.equal(card.classList.contains('review-panel-collapsible'), true)
    assert.equal((card as HTMLDetailsElement).open, false)
    assert.ok(card.querySelector('summary.review-panel-header'))
    assert.equal(card.querySelector('.review-panel-body')?.textContent, 'No issues found.')
  })

  it('keeps a review with issues expanded as a plain card', () => {
    const review: ThreadReview = {
      status: 'done',
      summary: '1 likely bug.',
      issuesFound: true,
    }
    const card = createReviewCardEl(review, fakeApi())
    assert.equal(card.tagName, 'DIV')
    assert.equal(card.classList.contains('review-panel-collapsible'), false)
    assert.equal(card.querySelector('.review-panel-body')?.textContent, '1 likely bug.')
  })

  it('linkifies printed file paths in the review summary so they open in the explorer', async () => {
    const review: ThreadReview = {
      status: 'done',
      summary: 'The change in src/main/index.ts looks risky.',
    }
    const card = createReviewCardEl(
      review,
      fakeApi([{ candidate: 'src/main/index.ts', path: 'src/main/index.ts' }]),
    )
    // annotateFileReferences resolves asynchronously; let its microtask settle.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const link = card.querySelector<HTMLAnchorElement>('a.file-reference-link')
    assert.ok(link, 'expected the printed file path to be linkified')
    assert.equal(link.dataset['fileReferencePath'], 'src/main/index.ts')
    assert.equal(link.textContent, 'src/main/index.ts')
  })
})
