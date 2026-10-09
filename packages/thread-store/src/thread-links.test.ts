import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message, Thread } from './thread-types.ts'
import {
  backlinksFor,
  collectThreadLinks,
  extractThreadLinks,
  MAX_LINKS_PER_THREAD,
  mergeThreadLinks,
} from './thread-links.ts'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

function message(content: string): Message {
  return { id: content.slice(0, 8), role: 'user', content, toolCalls: [], createdAt: 1 }
}

describe('thread links', () => {
  it('extracts web pages, dropping trailing punctuation, fragments and duplicates', () => {
    assert.deepEqual(
      extractThreadLinks(
        'See https://docs.example.com/a#intro, and (https://docs.example.com/a#other). Also http://localhost:5173/x.',
      ),
      [
        { kind: 'url', target: 'https://docs.example.com/a' },
        { kind: 'url', target: 'http://localhost:5173/x' },
      ],
    )
  })

  it('classifies Copse thread links and leaves GitHub PRs to the PR model', () => {
    assert.deepEqual(
      extractThreadLinks(
        `copse://thread/${ID} https://copse.dev/open/#thread=${ID.toUpperCase()} https://github.com/acme/widget/pull/42`,
      ),
      [{ kind: 'thread', target: ID }],
    )
  })

  it('ignores other schemes and malformed thread ids', () => {
    assert.deepEqual(
      extractThreadLinks('javascript:alert(1) ftp://x.test copse://thread/not-an-id'),
      [],
    )
  })

  it('collects across messages without self links', () => {
    const links = collectThreadLinks({
      id: ID,
      messages: [
        message('one https://a.test/'),
        message(`two copse://thread/${ID} https://a.test/ https://b.test/`),
      ],
    })
    assert.deepEqual(links, [
      { kind: 'url', target: 'https://a.test/' },
      { kind: 'url', target: 'https://b.test/' },
    ])
  })

  it('merges append-only and caps a thread', () => {
    const first = mergeThreadLinks([], [{ kind: 'url', target: 'https://a.test/' }])
    assert.equal(first.added, true)
    const again = mergeThreadLinks(first.links, [{ kind: 'url', target: 'https://a.test/' }])
    assert.equal(again.added, false)
    const many = Array.from({ length: MAX_LINKS_PER_THREAD + 5 }, (_, i) => ({
      kind: 'url' as const,
      target: `https://a.test/${String(i)}`,
    }))
    assert.equal(mergeThreadLinks([], many).links.length, MAX_LINKS_PER_THREAD)
  })

  it('finds backlinks among active threads only', () => {
    const base: Pick<Thread, 'id' | 'title'> = { id: 'x', title: 'x' }
    const link = [{ kind: 'url' as const, target: 'https://a.test/' }]
    assert.deepEqual(
      backlinksFor(
        [
          { ...base, id: 'b', title: 'B', links: link },
          { ...base, id: 'a', title: 'A', links: link },
          { ...base, id: 'gone', links: link, archivedAt: 1 },
          { ...base, id: 'none' },
        ],
        'url',
        'https://a.test/',
      ),
      [
        { threadId: 'a', title: 'A' },
        { threadId: 'b', title: 'B' },
      ],
    )
  })
})
