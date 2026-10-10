import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalWebLinkHandler } from './terminal-web-links.ts'

describe('terminal web links', () => {
  it('opens the link externally once the user confirms', async () => {
    const opened: string[] = []
    const handler = createTerminalWebLinkHandler(
      { openExternal: async (url) => void opened.push(url) },
      async () => true,
    )

    handler.activate(new MouseEvent('click'), 'https://claude.com/cai/oauth/authorize', {
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
    })
    await Promise.resolve()
    await Promise.resolve()

    assert.deepEqual(opened, ['https://claude.com/cai/oauth/authorize'])
  })

  it('does not open the link when the user cancels', async () => {
    const opened: string[] = []
    const handler = createTerminalWebLinkHandler(
      { openExternal: async (url) => void opened.push(url) },
      async () => false,
    )

    handler.activate(new MouseEvent('click'), 'https://example.com/', {
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
    })
    await Promise.resolve()
    await Promise.resolve()

    assert.deepEqual(opened, [])
  })

  it('asks for confirmation with the link url in the detail', async () => {
    const seen: string[] = []
    const handler = createTerminalWebLinkHandler({ openExternal: async () => {} }, async (uri) => {
      seen.push(uri)
      return false
    })

    handler.activate(new MouseEvent('click'), 'https://example.com/path', {
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
    })
    await Promise.resolve()

    assert.deepEqual(seen, ['https://example.com/path'])
  })
})
