import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  browserSelectionShare,
  captureBrowserPageText,
  captureBrowserScreenshot,
} from './browser-share.ts'

describe('browser thread sharing', () => {
  it('labels page text with its source and records clipped content', async () => {
    let script = ''
    const share = await captureBrowserPageText({
      executeJavaScript: (code) => {
        script = code
        return Promise.resolve({
          title: 'Reference page',
          url: 'https://example.com/guide',
          text: 'Visible browser text',
          omittedChars: 123,
        })
      },
    })

    assert.match(script, /document\.body\?\.innerText/)
    assert.equal(share.label, 'Browser page — Reference page')
    assert.match(share.content, /^Source: https:\/\/example\.com\/guide/)
    assert.match(share.content, /Visible browser text/)
    assert.match(share.content, /omitted 123 additional page characters/)
  })

  it('returns a PNG data URL for the visible viewport', async () => {
    const share = await captureBrowserScreenshot({
      capturePage: () =>
        Promise.resolve({
          toDataURL: () => 'data:image/png;base64,QUJD',
        }),
    })

    assert.deepEqual(share, {
      dataUrl: 'data:image/png;base64,QUJD',
      mimeType: 'image/png',
    })
  })

  it('turns the exact context-menu selection into sourced text', () => {
    const share = browserSelectionShare(
      {
        getTitle: () => '  Multi\nline   title  ',
        getURL: () => 'https://example.com/fallback',
      },
      'the current selection',
      'https://example.com/current',
    )

    assert.deepEqual(share, {
      label: 'Browser selection — Multi line title',
      content: 'Source: https://example.com/current\n\nthe current selection',
    })
  })
})
