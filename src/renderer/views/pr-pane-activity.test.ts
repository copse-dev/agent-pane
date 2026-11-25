import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { GhPrActivity, GhPrReviewThread } from '@shared/types/git.ts'
import { renderPrActivity } from './pr-pane-activity.ts'

const activity: GhPrActivity = {
  headSha: 'abc123456',
  commentsTruncated: false,
  checksTruncated: false,
  reviewThreads: [],
  reviewThreadsTruncated: false,
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
  it('renders quoted and fenced Markdown with copy controls but no command execution', () => {
    const host = document.createElement('div')
    const comment = activity.comments[0]
    assert.ok(comment)
    renderPrActivity(
      host,
      'comments',
      {
        ...activity,
        comments: [
          {
            ...comment,
            body: '> Keep failures visible.\n\n```sh\npnpm test\n```\n\n- [x] CI results',
          },
        ],
      },
      () => {},
    )
    assert.equal(host.querySelector('blockquote')?.textContent.trim(), 'Keep failures visible.')
    assert.equal(host.querySelector('pre code')?.textContent.trim(), 'pnpm test')
    assert.equal(host.querySelectorAll('.code-block-copy').length, 1)
    assert.equal(host.querySelector('.code-block-run'), null)
    assert.equal(host.querySelector('time')?.getAttribute('datetime'), comment.createdAt)
    assert.ok(host.querySelector('time')?.getAttribute('title'))
    assert.equal(
      host.querySelector('.pr-review-state-changes_requested')?.textContent,
      'changes requested',
    )
  })

  it('puts failed and running checks before collapsed successes and neutral results', () => {
    const host = document.createElement('div')
    renderPrActivity(
      host,
      'checks',
      {
        ...activity,
        checks: [
          { name: 'Passed first', state: 'SUCCESS', url: null },
          { name: 'Neutral', state: 'NEUTRAL', url: null },
          ...activity.checks,
        ],
      },
      () => {},
    )
    assert.deepEqual(
      [...host.querySelectorAll('.pr-check-group-heading > span:first-of-type')].map(
        (group) => group.textContent,
      ),
      ['Needs attention', 'In progress', 'Passed', 'Other results'],
    )
    assert.equal(host.querySelector('.pr-check-name')?.textContent, 'Test <img>')
    assert.equal(host.querySelector('details[open]'), null)
    assert.equal(host.querySelectorAll('.pr-check-state-success').length, 1)
    assert.equal(host.querySelectorAll('.pr-check-state-unknown').length, 3)
    renderPrActivity(
      host,
      'checks',
      { ...activity, checks: [{ name: 'Passed', state: 'SUCCESS', url: null }] },
      () => {},
    )
    assert.ok(host.querySelector('details[open]'))
  })
  it('offers a fix action only for failed checks and passes the selected check and head', () => {
    const host = document.createElement('div')
    const selected: string[] = []
    renderPrActivity(
      host,
      'checks',
      activity,
      () => {},
      (check, headSha) => {
        selected.push(check.name, headSha)
      },
    )
    const buttons = host.querySelectorAll<HTMLButtonElement>('.pr-check-fix-btn')
    assert.equal(buttons.length, 1)
    assert.equal(buttons[0]?.getAttribute('aria-label'), 'Fix Test <img>')
    buttons[0].click()
    assert.deepEqual(selected, ['Test <img>', activity.headSha])
    assert.equal(host.querySelector('img'), null)
  })
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

  describe('inline code discussions', () => {
    function thread(id: string, overrides: Partial<GhPrReviewThread> = {}): GhPrReviewThread {
      return {
        id,
        path: `src/${id}.ts`,
        line: 7,
        isResolved: false,
        isOutdated: false,
        commentsTruncated: false,
        comments: [
          {
            id: `${id}-c`,
            author: 'reviewer',
            body: `Fix **${id}**`,
            createdAt: '2026-09-09T11:00:00Z',
            url: `https://github.com/${id}`,
          },
        ],
        ...overrides,
      }
    }

    it('lists unresolved threads before the conversation and hands them to the agent', () => {
      const host = document.createElement('div')
      const addressed: string[][] = []
      const withThreads: GhPrActivity = {
        ...activity,
        reviewThreads: [
          thread('one'),
          thread('done', { isResolved: true, isOutdated: true, line: null }),
          thread('two'),
        ],
      }
      renderPrActivity(
        host,
        'comments',
        withThreads,
        () => {},
        undefined,
        (threads) => addressed.push(threads.map((item) => item.id)),
      )
      const open = [...host.querySelectorAll('.pr-review-threads > .pr-review-thread')]
      assert.deepEqual(
        open.map((item) => item.getAttribute('data-thread-id')),
        ['one', 'two'],
      )
      const [first] = open
      assert.ok(first)
      assert.equal(first.querySelector('.pr-review-thread-path')?.textContent, 'src/one.ts:7')
      assert.equal(first.querySelector('.pr-comment-body strong')?.textContent, 'one')
      assert.match(host.textContent, /2 unresolved/)
      const conversation = host.querySelector('.pr-conversation-heading')
      assert.ok(conversation)
      assert.ok(first.compareDocumentPosition(conversation) & Node.DOCUMENT_POSITION_FOLLOWING)

      const resolved = host.querySelector('details.pr-review-threads-resolved')
      assert.ok(resolved)
      assert.equal(resolved.hasAttribute('open'), false)
      assert.equal(resolved.querySelector('.pr-review-thread-path')?.textContent, 'src/done.ts')
      assert.match(resolved.textContent, /outdated/)
      assert.equal(resolved.querySelector('.pr-review-thread-address'), null)

      host.querySelector<HTMLButtonElement>('.pr-review-thread-address')?.click()
      host.querySelector<HTMLButtonElement>('.pr-review-thread-address-all')?.click()
      assert.deepEqual(addressed, [['one'], ['one', 'two']])
    })

    it('offers no Address all for a single thread and no actions without a handler', () => {
      const host = document.createElement('div')
      const single = { ...activity, reviewThreads: [thread('one')] }
      renderPrActivity(host, 'comments', single, () => {})
      assert.equal(host.querySelector('.pr-review-thread-address'), null)
      renderPrActivity(
        host,
        'comments',
        single,
        () => {},
        undefined,
        () => {},
      )
      assert.ok(host.querySelector('.pr-review-thread-address'))
      assert.equal(host.querySelector('.pr-review-thread-address-all'), null)
    })

    it('labels empty, truncated thread lists and threads with more replies on GitHub', () => {
      const host = document.createElement('div')
      renderPrActivity(host, 'comments', activity, () => {})
      assert.match(host.textContent, /No inline code discussions/)
      const opened: string[] = []
      renderPrActivity(
        host,
        'comments',
        {
          ...activity,
          reviewThreadsTruncated: true,
          reviewThreads: [thread('long', { commentsTruncated: true })],
        },
        (url) => opened.push(url),
      )
      assert.match(host.textContent, /first 100 code discussions/)
      host.querySelector<HTMLButtonElement>('.pr-review-thread-more button')?.click()
      assert.deepEqual(opened, ['https://github.com/long'])
    })
  })
})
