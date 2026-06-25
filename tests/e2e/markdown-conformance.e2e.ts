import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedMarkdownConformanceFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('markdown conformance quick wins', () => {
  before(async () => {
    resetUserData()
    seedMarkdownConformanceFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders spaced thematic breaks and multi-backtick code spans', async () => {
    await $('.message-text').waitForExist({ timeout: 15_000 })

    const dom = await browser.execute(() => {
      const root = document.querySelector('.message-text')
      if (!root) return { error: 'no message-text' }
      return {
        hrCount: root.querySelectorAll('hr').length,
        emCount: root.querySelectorAll('em').length,
        liCount: root.querySelectorAll('li').length,
        codeTexts: [...root.querySelectorAll('code')].map((c) => c.textContent ?? ''),
      }
    })

    expect(dom).not.toHaveProperty('error')
    // `* * *` and `- - -` both become real <hr>, not lists or stray emphasis.
    expect(dom.hrCount).toBe(2)
    expect(dom.emCount).toBe(0)
    expect(dom.liCount).toBe(0)
    // Multi-backtick span preserves the interior backtick; ``code`` also renders.
    expect(dom.codeTexts).toContain('foo ` bar')
    expect(dom.codeTexts).toContain('code')

    await saveAppScreenshot('markdown-conformance-quickwins.png')
  })
})
