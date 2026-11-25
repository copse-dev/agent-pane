import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { GhPrActivity, GhPrReviewThread, PrActionResult } from '@shared/types/git.ts'
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
      renderPrActivity(host, 'comments', withThreads, () => {}, undefined, {
        address: (threads) => addressed.push(threads.map((item) => item.id)),
      })
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
      renderPrActivity(host, 'comments', single, () => {}, undefined, { address: () => {} })
      assert.ok(host.querySelector('.pr-review-thread-address'))
      assert.equal(host.querySelector('.pr-review-reply-input'), null)
      assert.equal(host.querySelector('.pr-review-resolve-btn'), null)
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

    it('posts a reply once, keeps the draft on failure, and clears it on success', async () => {
      const host = document.createElement('div')
      const drafts = new Map<string, string>([['one', 'Earlier draft']])
      const posted: string[] = []
      let next: PrActionResult = { ok: false, backend: 'mock', message: 'Not allowed' }
      let release: () => void = () => {}
      let refreshes = 0
      const actions = {
        drafts,
        refresh: (): void => {
          // The draft is already cleared when the caller re-renders.
          assert.equal(drafts.has('one'), false)
          refreshes++
        },
        reply: async (target: GhPrReviewThread, body: string): Promise<PrActionResult> => {
          posted.push(`${target.id}:${body}`)
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return next
        },
      }
      renderPrActivity(
        host,
        'comments',
        { ...activity, reviewThreads: [thread('one')] },
        () => {},
        undefined,
        actions,
      )
      const input = host.querySelector<HTMLTextAreaElement>('.pr-review-reply-input')
      const send = host.querySelector<HTMLButtonElement>('.pr-review-reply-btn')
      const status = host.querySelector<HTMLElement>('.pr-review-thread-status')
      assert.ok(input && send && status)
      assert.equal(input.value, 'Earlier draft')
      input.value = '  Fixed in the next push  '
      input.dispatchEvent(new Event('input'))
      assert.equal(drafts.get('one'), '  Fixed in the next push  ')
      send.click()
      send.click()
      assert.deepEqual(posted, ['one:Fixed in the next push'])
      assert.equal(send.disabled, true)
      assert.equal(input.disabled, true)
      assert.equal(status.textContent, 'Posting reply…')
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(status.textContent, 'Not allowed')
      assert.equal(status.getAttribute('data-ok'), 'false')
      assert.equal(refreshes, 0)
      assert.equal(send.disabled, false)
      assert.equal(drafts.get('one'), '  Fixed in the next push  ')

      next = { ok: true, backend: 'mock', message: 'Reply posted.' }
      send.click()
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(status.textContent, 'Reply posted.')
      assert.equal(drafts.has('one'), false)
      assert.equal(refreshes, 1)
      // Stays busy until the caller re-renders with GitHub's state.
      assert.equal(send.disabled, true)
    })

    it('does not send an empty reply and submits with Cmd or Ctrl+Enter', () => {
      const host = document.createElement('div')
      const posted: string[] = []
      renderPrActivity(
        host,
        'comments',
        { ...activity, reviewThreads: [thread('one')] },
        () => {},
        undefined,
        {
          reply: (_target, body) => {
            posted.push(body)
            return Promise.resolve({ ok: true, backend: 'mock', message: 'Reply posted.' })
          },
        },
      )
      const input = host.querySelector<HTMLTextAreaElement>('.pr-review-reply-input')
      const send = host.querySelector<HTMLButtonElement>('.pr-review-reply-btn')
      assert.ok(input && send)
      assert.equal(send.disabled, true)
      input.value = '   '
      input.dispatchEvent(new Event('input'))
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }))
      assert.deepEqual(posted, [])
      input.value = 'Done'
      input.dispatchEvent(new Event('input'))
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true }))
      assert.deepEqual(posted, ['Done'])
    })

    it('resolves open threads and only reopens resolved ones', () => {
      const host = document.createElement('div')
      const changes: string[] = []
      renderPrActivity(
        host,
        'comments',
        { ...activity, reviewThreads: [thread('one'), thread('done', { isResolved: true })] },
        () => {},
        undefined,
        {
          address: () => {},
          reply: () => Promise.resolve({ ok: true, backend: 'mock', message: '' }),
          setResolved: (target, resolved) => {
            changes.push(`${target.id}:${String(resolved)}`)
            return Promise.resolve({ ok: true, backend: 'mock', message: 'Done' })
          },
        },
      )
      const open = host.querySelector('.pr-review-threads > .pr-review-thread')
      const done = host.querySelector('.pr-review-threads-resolved .pr-review-thread')
      assert.ok(open && done)
      assert.equal(open.querySelector('.pr-review-resolve-btn')?.textContent, 'Resolve')
      assert.equal(done.querySelector('.pr-review-resolve-btn')?.textContent, 'Reopen')
      assert.equal(done.querySelector('.pr-review-reply-input'), null)
      assert.equal(done.querySelector('.pr-review-thread-address'), null)
      open.querySelector<HTMLButtonElement>('.pr-review-resolve-btn')?.click()
      done.querySelector<HTMLButtonElement>('.pr-review-resolve-btn')?.click()
      assert.deepEqual(changes, ['one:true', 'done:false'])
    })
  })
})
