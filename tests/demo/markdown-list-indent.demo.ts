import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot, savePreparedElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted markdown geometry', () => {
  beforeEach(async () => {
    await browser.url('/?scenario=markdown-list-indent')
    await $('.message-text h3').waitForExist()
  })

  it('preserves list structure, indentation, and compact row spacing', async () => {
    const layout = await browser.execute(() => {
      const root = document.querySelector('.message-text')
      if (!root) return { error: 'no message-text' }

      const architectureHeading = [...root.querySelectorAll('h3')].find((candidate) =>
        candidate.textContent?.includes('Architecture Highlights'),
      )
      const knownFailuresSubheading = [...root.querySelectorAll('p strong')].find((candidate) =>
        candidate.textContent?.includes('Unit tests'),
      )
      const architectureList = architectureHeading?.nextElementSibling ?? null
      const knownFailuresList = knownFailuresSubheading?.closest('p')?.nextElementSibling ?? null
      const architectureItems = architectureList ? [...architectureList.querySelectorAll('li')] : []
      const architectureItem = architectureItems[0]
      const knownFailuresItem = knownFailuresList?.querySelector('li')
      const first = architectureItems[0]
      const second = architectureItems[1]

      return {
        h3Count: root.querySelectorAll('h3').length,
        listsInsideParagraphs: root.querySelectorAll('p ul').length,
        architectureHeadingIsFollowedByUl: architectureList?.tagName === 'UL',
        knownFailuresHeadingIsFollowedByUl: knownFailuresList?.tagName === 'UL',
        architectureHeadingLeft: architectureHeading?.getBoundingClientRect().left ?? 0,
        architectureItemLeft: architectureItem?.getBoundingClientRect().left ?? 0,
        subheadingLeft: knownFailuresSubheading?.getBoundingClientRect().left ?? 0,
        knownFailuresItemLeft: knownFailuresItem?.getBoundingClientRect().left ?? 0,
        architectureItemGap:
          first && second
            ? second.getBoundingClientRect().top - first.getBoundingClientRect().bottom
            : 999,
      }
    })

    expect(layout).not.toHaveProperty('error')
    if ('error' in layout) throw new Error(layout.error)
    expect(layout.h3Count).toBe(2)
    expect(layout.listsInsideParagraphs).toBe(0)
    expect(layout.architectureHeadingIsFollowedByUl).toBe(true)
    expect(layout.knownFailuresHeadingIsFollowedByUl).toBe(true)
    expect(layout.architectureItemLeft).toBeGreaterThan(layout.architectureHeadingLeft + 4)
    expect(layout.knownFailuresItemLeft).toBeGreaterThan(layout.subheadingLeft + 4)
    expect(layout.architectureItemGap).toBeLessThan(12)

    await saveAppScreenshot('markdown-list-indent-multi-section.png')
    await savePreparedElementScreenshot('.message-text', 'markdown-list-indent-architecture.png')
  })

  it('streams a scripted response through the real renderer event path', async () => {
    const prompt = 'Show the browser demo event path.'
    await browser.execute((text) => {
      const composer = document.querySelector<HTMLElement>('.prompt-input')
      if (!composer) return
      composer.textContent = text
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    }, prompt)
    await $('.submit-btn').click()

    await browser.waitUntil(
      async () => {
        const text = await browser.execute(
          () => document.querySelector('.messages-list')?.textContent ?? '',
        )
        return text.includes(`Demo response to: ${prompt}`)
      },
      { timeoutMsg: 'expected the demo ApiClient to emit a rendered response' },
    )
  })
})
