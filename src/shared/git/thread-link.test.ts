import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appendThreadLink, parseThreadDeepLink } from './thread-link.ts'

const ID = '12345678-1234-1234-1234-123456789abc'

describe('thread links', () => {
  it('accepts only the exact navigation protocol and opaque ID', () => {
    assert.equal(parseThreadDeepLink(`copse://thread/${ID}`), ID)
    for (const url of [
      `https://thread/${ID}`,
      `copse://thread/${ID}?run=1`,
      `copse://thread/${ID}#x`,
      `copse://thread/${ID}/`,
      'copse://thread/../../etc/passwd',
      'copse://run/command',
      `copse://user@thread/${ID}`,
      `copse://thread/%31${ID.slice(1)}`,
    ])
      assert.equal(parseThreadDeepLink(url), null, url)
  })

  it('adds a stable HTTPS trailer, including empty PR bodies', () => {
    const trailer = `Copse-Thread: https://copse.dev/open/#thread=${ID}\n`
    assert.equal(appendThreadLink('Subject\n', ID), `Subject\n\n${trailer}`)
    assert.equal(appendThreadLink('', ID), trailer)
    const once = appendThreadLink('Subject', ID)
    assert.equal(appendThreadLink(once, ID), once)
    assert.equal(appendThreadLink('Subject', null), 'Subject')
    assert.equal(appendThreadLink('Subject', '../local/path'), 'Subject')
  })
})
