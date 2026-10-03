import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

describe('thread-link landing page', () => {
  it('requires a valid fragment, removes stale links, and never auto-launches', () => {
    const code = readFileSync('site/open/open.js', 'utf8')
    const button = {
      hidden: true,
      href: '',
      removeAttribute: (): void => {
        button.href = ''
      },
    }
    const status = { textContent: '' }
    const location = { hash: '' }
    let update: (() => void) | undefined
    runInNewContext(code, {
      location,
      document: { getElementById: (id: string) => (id === 'status' ? status : button) },
      window: {
        addEventListener: (_event: string, handler: () => void) => {
          update = handler
        },
      },
    })
    assert.equal(button.hidden, true)
    location.hash = '#thread=12345678-1234-1234-1234-123456789abc'
    update?.()
    assert.equal(button.hidden, false)
    assert.equal(button.href, 'copse://thread/12345678-1234-1234-1234-123456789abc')
    assert.equal(location.hash, '#thread=12345678-1234-1234-1234-123456789abc')
    location.hash += '&run=1'
    update?.()
    assert.equal(button.hidden, true)
    assert.equal(button.href, '')
  })
})
