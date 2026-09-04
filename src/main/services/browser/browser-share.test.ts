import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  browserSelectionShare,
  captureBrowserPageText,
  captureBrowserScreenshot,
  exportBrowserPagePdf,
  suggestedPdfFilename,
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

interface FakePdfContents {
  getTitle: () => string
  getURL: () => string
  printToPDF: (options: { printBackground: boolean }) => Promise<Uint8Array>
}

describe('browser PDF export', () => {
  function pdfContents(title: string, url = 'https://example.com/guide'): FakePdfContents {
    return {
      getTitle: (): string => title,
      getURL: (): string => url,
      printToPDF: (options: { printBackground: boolean }): Promise<Uint8Array> => {
        assert.equal(options.printBackground, true)
        return Promise.resolve(Uint8Array.from([0x25, 0x50, 0x44, 0x46]))
      },
    }
  }

  it('names the file after the page title, falling back to the hostname', () => {
    assert.equal(
      suggestedPdfFilename('Quarterly report', 'https://example.com/q'),
      'Quarterly report.pdf',
    )
    assert.equal(suggestedPdfFilename('', 'https://example.com/q'), 'example.com.pdf')
    assert.equal(suggestedPdfFilename('', 'about:blank'), 'Browser page.pdf')
  })

  it('strips path separators and leading dots from page-controlled titles', () => {
    // Interior dots may survive, but no separator does and the name cannot
    // start with one — so it stays a plain filename in the chosen directory.
    assert.equal(
      suggestedPdfFilename('../../etc/passwd', 'https://example.com/'),
      '-..-etc-passwd.pdf',
    )
    assert.equal(
      suggestedPdfFilename('a:b*c?d|e"f<g>h', 'https://example.com/'),
      'a-b-c-d-e-f-g-h.pdf',
    )
  })

  it('writes the printed bytes to the chosen path', async () => {
    const writes: { filePath: string; bytes: number[] }[] = []
    let offered = ''
    const saved = await exportBrowserPagePdf(
      pdfContents('Reference page'),
      (defaultFilename) => {
        offered = defaultFilename
        return Promise.resolve('/tmp/out/Reference page.pdf')
      },
      (filePath, data) => {
        writes.push({ filePath, bytes: [...data] })
        return Promise.resolve()
      },
    )

    assert.equal(offered, 'Reference page.pdf')
    assert.equal(saved, '/tmp/out/Reference page.pdf')
    assert.deepEqual(writes, [
      { filePath: '/tmp/out/Reference page.pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
    ])
  })

  it('prints nothing when the user cancels the save dialog', async () => {
    let printed = 0
    const saved = await exportBrowserPagePdf(
      {
        getTitle: () => 'Reference page',
        getURL: () => 'https://example.com/guide',
        printToPDF: () => {
          printed += 1
          return Promise.resolve(new Uint8Array())
        },
      },
      () => Promise.resolve(null),
      () => {
        assert.fail('cancelled export must not write a file')
      },
    )

    assert.equal(saved, null)
    assert.equal(printed, 0, 'cancelling skips the print entirely')
  })
})
