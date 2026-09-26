import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CONVERSATION_CHARS,
  buildConversation,
  extractImages,
  readPullRequestConversation,
  renderPullRequestConversation,
  type PullRequestRef,
} from './pr-conversation.ts'
import { isCopseReviewBody, type FetchLike } from './forge-review.ts'

const SHA_BEFORE = 'd5b006fa3ff06fa2c0b6e0cb0969ffbf10166dfd'
const SHA_AFTER = 'a517e0011776800309f93024f51aba3feb75ccb4'
const raw = (sha: string, name: string): string =>
  `https://github.com/acme/app/raw/${sha}/tests/screens/${name}`

/** The shape screenshot automation commonly posts: a before/after table of <img> tags. */
const SCREENSHOT_TABLE = [
  '<!-- screenshot-bot -->',
  '### Screenshot evidence',
  '',
  '| Screenshot | Before | After |',
  '| --- | --- | --- |',
  `| \`settings.png\` | <img src="${raw(SHA_BEFORE, 'settings.png')}" width="360"> | <img src="${raw(SHA_AFTER, 'settings.png')}" width="360"> |`,
  `| \`toolbar.png\` | *new* | <img src="${raw(SHA_AFTER, 'toolbar.png')}" width="360"> |`,
  '',
  'Cherry-pick the candidates if they look right.',
].join('\n')

function ids(images: readonly { label: string }[]): string[] {
  return images.map((image) => image.label)
}

describe('extractImages', () => {
  it('labels table images by row and column and replaces them with handles', () => {
    let next = 0
    const { text, images } = extractImages(SCREENSHOT_TABLE, () => `img-${String(++next)}`)
    assert.deepEqual(ids(images), [
      'settings.png — Before',
      'settings.png — After',
      'toolbar.png · new — After',
    ])
    assert.match(text, /\| `settings.png` \| \[image img-1\] \| \[image img-2\] \|/)
    assert.doesNotMatch(text, /<img/)
  })

  it('labels loose images by alt text, else file name, and skips what cannot be fetched', () => {
    let next = 0
    const { text, images } = extractImages(
      [
        '![the broken dialog](https://example.com/shots/dialog.png)',
        '<img alt="" src=\'https://example.com/a/b/wide%20view.jpg\'>',
        '![inline](data:image/png;base64,AAAA)',
        '![relative](docs/diagram.png)',
        '![plain](http://example.com/insecure.png)',
      ].join('\n'),
      () => `img-${String(++next)}`,
    )
    assert.deepEqual(
      images.map((image) => [image.url, image.label]),
      [
        ['https://example.com/shots/dialog.png', 'the broken dialog'],
        ['https://example.com/a/b/wide%20view.jpg', 'wide view.jpg'],
      ],
    )
    assert.match(text, /\(data:image\/png/)
    assert.match(text, /docs\/diagram\.png/)
    assert.match(text, /http:\/\/example\.com\/insecure\.png/)
  })
})

describe('buildConversation', () => {
  it('reuses one handle for a repeated image and keeps the description under budget pressure', () => {
    const filler = 'x'.repeat(MAX_CONVERSATION_CHARS / 4)
    const conversation = buildConversation('Tidy the toolbar', [
      {
        kind: 'description',
        author: 'alice',
        bot: false,
        createdAt: '2026-09-01T00:00:00Z',
        body: `Before: ![toolbar](${raw(SHA_BEFORE, 'toolbar.png')})`,
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        kind: 'comment' as const,
        author: 'bob',
        bot: false,
        createdAt: `2026-09-0${String(index + 2)}T00:00:00Z`,
        body: `${String(index)} ${filler}`,
      })),
      {
        kind: 'comment',
        author: 'carol',
        bot: false,
        createdAt: '2026-09-20T00:00:00Z',
        body: `Same picture: ![again](${raw(SHA_BEFORE, 'toolbar.png')})`,
      },
    ])
    assert.equal(conversation.images.length, 1)
    assert.equal(conversation.entries[0]?.kind, 'description')
    assert.match(conversation.entries.at(-1)?.body ?? '', /\[image img-1\]/)
    assert.ok(conversation.omittedEntries > 0)
    const kept = conversation.entries.reduce((sum, entry) => sum + entry.body.length, 0)
    assert.ok(kept <= MAX_CONVERSATION_CHARS)
  })
})

interface Route {
  readonly status?: number
  readonly body: unknown
}

function fakeForge(routes: Record<string, Route>): { fetch: FetchLike; requested: string[] } {
  const requested: string[] = []
  const fetch: FetchLike = (url, init) => {
    requested.push(`${init.method} ${url}`)
    const path = new URL(url).pathname
    const route = routes[path]
    return Promise.resolve({
      status: route === undefined ? 404 : (route.status ?? 200),
      text: () => Promise.resolve(JSON.stringify(route?.body ?? { message: 'Not Found' })),
    })
  }
  return { fetch, requested }
}

const GITHUB: PullRequestRef = {
  forge: 'github',
  apiBase: 'https://api.github.com',
  owner: 'acme',
  repo: 'app',
  number: 7,
  token: 'secret-token',
}

describe('readPullRequestConversation', () => {
  it('reads GitHub discussion, reviews and inline comments, skipping Copse Reviewer’s own', async () => {
    const copseReview = `### Copse Reviewer\n\nNo findings.\n<!-- copse-review:${'c'.repeat(40)} -->`
    const { fetch } = fakeForge({
      '/repos/acme/app/pulls/7': {
        body: {
          title: 'Tidy the toolbar',
          body: 'Moves the save button.',
          user: { login: 'alice', type: 'User' },
          created_at: '2026-09-01T00:00:00Z',
        },
      },
      '/repos/acme/app/issues/7/comments': {
        body: [
          {
            body: SCREENSHOT_TABLE,
            user: { login: 'github-actions[bot]', type: 'Bot' },
            created_at: '2026-09-03T00:00:00Z',
          },
          {
            body: 'Looks good once the icon is fixed.',
            user: { login: 'bob', type: 'User' },
            created_at: '2026-09-02T00:00:00Z',
          },
        ],
      },
      '/repos/acme/app/pulls/7/reviews': {
        body: [
          {
            id: 1,
            body: copseReview,
            state: 'COMMENTED',
            user: { login: 'copse[bot]', type: 'Bot' },
            submitted_at: '2026-09-04T00:00:00Z',
          },
          {
            id: 2,
            body: '',
            state: 'CHANGES_REQUESTED',
            user: { login: 'carol', type: 'User' },
            submitted_at: '2026-09-05T00:00:00Z',
          },
          {
            id: 3,
            body: '',
            state: 'COMMENTED',
            user: { login: 'dave', type: 'User' },
            submitted_at: '2026-09-05T00:00:00Z',
          },
        ],
      },
      '/repos/acme/app/pulls/7/comments': {
        body: [
          {
            body: 'Our own inline finding',
            user: { login: 'copse[bot]', type: 'Bot' },
            created_at: '2026-09-04T00:00:00Z',
            path: 'src/toolbar.css',
            line: 3,
            pull_request_review_id: 1,
          },
          {
            body: 'This padding clips the label.',
            user: { login: 'carol', type: 'User' },
            created_at: '2026-09-05T00:00:00Z',
            path: 'src/toolbar.css',
            line: null,
            original_line: 12,
            pull_request_review_id: 2,
          },
        ],
      },
    })
    const conversation = await readPullRequestConversation(GITHUB, { fetch })
    assert.equal(conversation.skippedOwnReviews, 1)
    assert.deepEqual(
      conversation.entries.map((entry) => `${entry.kind}:${entry.author}`),
      [
        'description:alice',
        'comment:bob',
        'comment:github-actions[bot]',
        'review:carol',
        'review-comment:carol',
      ],
    )
    assert.equal(conversation.entries[2]?.bot, true)
    assert.equal(conversation.entries[4]?.line, 12)
    assert.equal(conversation.images.length, 3)
    assert.equal(conversation.images[0]?.postedIn, 'comment by github-actions[bot] (bot)')

    const rendered = renderPullRequestConversation(conversation)
    assert.match(rendered, /^<external_content source="pull_request_conversation">/)
    assert.match(rendered, /review by carol \[CHANGES_REQUESTED\]/)
    assert.match(rendered, /review comment by carol on src\/toolbar\.css:12/)
    assert.match(rendered, /- img-2: settings\.png — After \(comment by github-actions/)
    assert.doesNotMatch(rendered, /Our own inline finding|No findings/)
  })

  it('reads Forgejo through /api/v1 with per-review comments and a token header', async () => {
    const headersSeen: Record<string, string>[] = []
    const routes: Record<string, Route> = {
      '/api/v1/repos/acme/app/pulls/7': {
        body: {
          title: 'T',
          body: null,
          user: { login: 'alice' },
          created_at: '2026-09-01T00:00:00Z',
        },
      },
      '/api/v1/repos/acme/app/issues/7/comments': { body: [] },
      '/api/v1/repos/acme/app/pulls/7/reviews': {
        body: [
          {
            id: 9,
            body: 'See inline',
            state: 'REQUEST_CHANGES',
            user: { login: 'bob' },
            submitted_at: '2026-09-02T00:00:00Z',
          },
        ],
      },
      '/api/v1/repos/acme/app/pulls/7/reviews/9/comments': {
        body: [
          {
            body: '![clipped](https://code.example.org/attachments/abc)',
            user: { login: 'bob' },
            created_at: '2026-09-02T00:00:00Z',
            path: 'src/a.css',
            position: 4,
          },
        ],
      },
    }
    const { fetch: inner } = fakeForge(routes)
    const fetch: FetchLike = (url, init) => {
      headersSeen.push(init.headers)
      return inner(url, init)
    }
    const conversation = await readPullRequestConversation(
      { ...GITHUB, forge: 'forgejo', apiBase: 'https://code.example.org', token: 'fj' },
      { fetch },
    )
    assert.deepEqual(
      conversation.entries.map((entry) => entry.kind),
      ['description', 'review', 'review-comment'],
    )
    assert.equal(conversation.images[0]?.label, 'clipped')
    assert.ok(headersSeen.every((headers) => headers['Authorization'] === 'token fj'))
  })

  it('fails with the forge’s status rather than reviewing half a conversation', async () => {
    const { fetch } = fakeForge({})
    await assert.rejects(
      readPullRequestConversation({ ...GITHUB, token: undefined }, { fetch }),
      /github returned 404/,
    )
  })

  it('recognises every body Copse Reviewer leaves on a review, and nothing a person writes', () => {
    const sha = 'd'.repeat(40)
    assert.ok(isCopseReviewBody(`### Copse Reviewer\n\nOne finding.\n<!-- copse-review:${sha} -->`))
    assert.ok(isCopseReviewBody('### Copse Reviewer\n\nSuperseded by [a newer review](https://x).'))
    assert.ok(
      isCopseReviewBody(
        '### Copse Reviewer\n\nResolved: a newer review of `abc` raised no new issues.',
      ),
    )
    assert.ok(!isCopseReviewBody('The Copse Reviewer finding above is wrong: see line 3.'))
  })
})
