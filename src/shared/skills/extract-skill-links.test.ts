import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractExternalLinkHosts } from './extract-skill-links.ts'

describe('extractExternalLinkHosts', () => {
  it('returns no hosts for text without external links', () => {
    assert.deepEqual(extractExternalLinkHosts('# Skill\n\nDo a thing locally.'), [])
    assert.deepEqual(extractExternalLinkHosts('no links here'), [])
  })

  it('extracts hosts from markdown links, autolinks, and bare URLs', () => {
    const text = [
      'See [docs](https://example.com/guide) for details.',
      'Autolink: <https://autolink.dev/path>',
      'Bare: http://bare.example.org/x and trailing https://trailing.test.',
    ].join('\n')
    assert.deepEqual(extractExternalLinkHosts(text), [
      'autolink.dev',
      'bare.example.org',
      'example.com',
      'trailing.test',
    ])
  })

  it('de-duplicates by hostname case-insensitively', () => {
    const text = 'https://Example.com/a https://example.com/b http://EXAMPLE.COM/c'
    assert.deepEqual(extractExternalLinkHosts(text), ['example.com'])
  })

  it('ignores non-http schemes and relative paths', () => {
    const text = 'mailto:a@b.com file:///etc/passwd ./local/script.sh ../up.md'
    assert.deepEqual(extractExternalLinkHosts(text), [])
  })

  it('strips trailing sentence punctuation from the host', () => {
    assert.deepEqual(extractExternalLinkHosts('Go to https://example.com.'), ['example.com'])
    assert.deepEqual(extractExternalLinkHosts('(see https://example.org)'), ['example.org'])
  })
})
