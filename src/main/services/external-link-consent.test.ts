import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  externalLinkConfirmationDetail,
  externalLinkReview,
  openExternalWithConsent,
} from './external-link-consent.ts'

describe('external link consent', () => {
  it('shows the parsed destination and exact URL that will be opened', async () => {
    const href = 'https://docs.example.test/path?q=reviewed%20text'
    const seen: string[] = []
    const opened = await openExternalWithConsent(
      href,
      async (review) => {
        seen.push(externalLinkConfirmationDetail(review))
        return true
      },
      async (url) => {
        seen.push(url)
      },
    )
    assert.equal(opened, true)
    assert.match(seen[0] ?? '', /Destination: docs\.example\.test/)
    assert.ok(seen[0]?.includes(href))
    assert.equal(seen[1], href)
  })

  it('reviews and opens the same canonical URL for ambiguous input', async () => {
    const seen: string[] = []
    await openExternalWithConsent(
      'https://example.test\\@other.test',
      async (review) => {
        seen.push(review.href)
        return true
      },
      async (href) => {
        seen.push(href)
      },
    )
    assert.deepEqual(seen, ['https://example.test/@other.test', 'https://example.test/@other.test'])
  })

  it('never opens after denial or for an invalid or oversized URL', async () => {
    const opened: string[] = []
    const open = async (url: string): Promise<void> => {
      opened.push(url)
    }
    assert.equal(
      await openExternalWithConsent('https://example.test/', async () => false, open),
      false,
    )
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:password@example.test/',
      'https://example.test/\nDestination: trusted.test',
      `https://example.test/${'x'.repeat(2048)}`,
    ]) {
      assert.equal(externalLinkReview(url), null)
      assert.equal(
        await openExternalWithConsent(
          url,
          async () => {
            throw new Error('Invalid URL reached confirmation')
          },
          open,
        ),
        false,
      )
    }
    assert.deepEqual(opened, [])
  })
})
