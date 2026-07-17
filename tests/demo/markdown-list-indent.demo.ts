import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser demo markdown geometry', () => {
  beforeEach(async () => {
    await browser.url('/?scenario=markdown-list-indent')
    await $('.message-text h3').waitForExist()
  })

  it('preserves list structure and computed indentation without Electron', async () => {
    const layout = await browser.execute(() => {
      const root = document.querySelector('.message-text')
      const heading = [...(root?.querySelectorAll('h3') ?? [])].find((candidate) =>
        candidate.textContent?.includes('Architecture Highlights'),
      )
      const list = heading?.nextElementSibling
      const items = list ? [...list.querySelectorAll('li')] : []
      const first = items[0]
      const second = items[1]
      return {
        h3Count: root?.querySelectorAll('h3').length ?? 0,
        listsInsideParagraphs: root?.querySelectorAll('p ul').length ?? -1,
        headingFollowedByList: list?.tagName === 'UL',
        headingLeft: heading?.getBoundingClientRect().left ?? 0,
        itemLeft: first?.getBoundingClientRect().left ?? 0,
        itemGap:
          first && second
            ? second.getBoundingClientRect().top - first.getBoundingClientRect().bottom
            : 999,
      }
    })

    expect(layout.h3Count).toBe(2)
    expect(layout.listsInsideParagraphs).toBe(0)
    expect(layout.headingFollowedByList).toBe(true)
    expect(layout.itemLeft).toBeGreaterThan(layout.headingLeft + 4)
    expect(layout.itemGap).toBeLessThan(12)

    await saveAppScreenshot('demo-spike-markdown-list-indent.png')
  })

  it('streams a scripted browser response through the renderer event path', async () => {
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
