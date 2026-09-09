import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { GhPrActivity } from '@shared/types/git.ts'
import { renderPrActivity } from './pr-pane-activity.ts'

const activity: GhPrActivity = {
  headSha: 'abc123456',
  commentsTruncated: false,
  checksTruncated: false,
  comments: [
    {
      id: '1',
      author: '<reviewer>',
      body: '**Please fix** the failing test.',
      createdAt: '2026-09-09T10:00:00Z',
      url: 'https://github.com/comment',
      reviewState: 'CHANGES_REQUESTED',
    },
  ],
  checks: [
    { name: 'Test <img>', state: 'FAILURE', url: 'https://ci.example/test' },
    { name: 'Build', state: 'IN_PROGRESS', url: null },
    { name: 'Cancelled', state: 'CANCELLED', url: 'javascript:alert(1)' },
    { name: 'Unknown', state: 'UNKNOWN', url: null },
  ],
}

describe('PR activity views', () => {
  it('renders markdown and review outcomes with literal author text and no per-comment action', () => {
    const host = document.createElement('div')
    renderPrActivity(host, 'comments', activity, () => {})
    assert.equal(host.querySelector('.pr-comment-body strong')?.textContent, 'Please fix')
    assert.ok(host.textContent.includes('changes requested'))
    assert.equal(host.querySelector('reviewer'), null)
    assert.equal(host.querySelector('.pr-activity-link'), null)
  })

  it('shows failures alongside running checks without painting unknown or cancelled states green', () => {
    const host = document.createElement('div')
    renderPrActivity(host, 'checks', activity, () => {})
    assert.equal(host.querySelectorAll('.pr-check-state-failure').length, 1)
    assert.equal(host.querySelectorAll('.pr-check-state-pending').length, 1)
    assert.equal(host.querySelectorAll('.pr-check-state-success').length, 0)
    assert.equal(host.querySelectorAll('.pr-check-state-unknown').length, 2)
    assert.equal(host.querySelectorAll('.pr-activity-link').length, 1)
    assert.equal(host.querySelector('img'), null)
  })

  it('distinguishes empty, unavailable, and truncated results', () => {
    const host = document.createElement('div')
    renderPrActivity(host, 'comments', undefined, () => {})
    assert.match(host.textContent, /unavailable/)
    assert.doesNotMatch(host.textContent, /No conversation/)
    renderPrActivity(host, 'checks', { ...activity, checks: [] }, () => {})
    assert.match(host.textContent, /No checks reported/)
    renderPrActivity(host, 'comments', { ...activity, commentsTruncated: true }, () => {})
    assert.match(host.textContent, /latest 50/)
    renderPrActivity(host, 'checks', { ...activity, checksTruncated: true }, () => {})
    assert.match(host.textContent, /first 100/)
  })
})
