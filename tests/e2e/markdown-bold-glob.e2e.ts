import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedMarkdownBoldGlobFixture } from './helpers/seed-config.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import {
  prepareE2eScreenshot,
  waitForSettledLayout,
  withCaptureFrame,
} from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Keep the existing full-window views: latest content at the natural bottom,
// then Architecture at its native scrollIntoView target (clamped when needed).
async function prepareMarkdownCapture(position: 'bottom' | 'architecture'): Promise<void> {
  // Prepare at the real native window size before waiting on its layout sync.
  const nativeViewport = await browser.execute(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
  await prepareE2eScreenshot(nativeViewport)
  await waitForSettledLayout('#input-bar')
  // A stable composer box alone does not establish that its reserved height matches.
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const pane = document.getElementById('pane-chat')
        const composer = document.getElementById('input-bar')
        if (!pane || !composer) return false
        const appliedInset = Number.parseFloat(
          getComputedStyle(pane).getPropertyValue('--chat-composer-height'),
        )
        const expectedInset = Math.max(Math.ceil(composer.getBoundingClientRect().height), 72)
        return document.fonts.status === 'loaded' && appliedInset === expectedInset
      }),
    { timeoutMsg: 'Markdown capture composer reserve did not match its measured height' },
  )
  await waitForSettledLayout('.messages-list')
  const target = await browser.execute((position) => {
    const transcript = document.querySelector<HTMLElement>('.messages-list')
    const root = document.querySelector('[data-message-id="msg-assistant-bold-glob"] .message-text')
    const heading = [...(root?.querySelectorAll('h2') ?? [])].find((h) =>
      h.textContent.includes('Architecture Notes'),
    )
    if (!transcript || !heading) throw new Error('missing markdown capture target')
    if (position === 'bottom')
      transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'instant' })
    else heading.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' })
    return {
      scrollTop: transcript.scrollTop,
      width: window.innerWidth,
      height: window.innerHeight,
    }
  }, position)
  await waitForSettledLayout('.messages-list')
  const geometry = await browser.execute(() => {
    const transcript = document.querySelector<HTMLElement>('.messages-list')
    const root = document.querySelector('[data-message-id="msg-assistant-bold-glob"] .message-text')
    const heading = [...(root?.querySelectorAll('h2') ?? [])].find((h) =>
      h.textContent.includes('Architecture Notes'),
    )
    const list = heading?.nextElementSibling
    const pane = document.getElementById('pane-chat')
    const composer = document.getElementById('input-bar')
    if (!transcript || !heading || !list || !pane || !composer)
      throw new Error('missing markdown capture geometry')
    const port = transcript.getBoundingClientRect()
    const composerRect = composer.getBoundingClientRect()
    return {
      fonts: document.fonts.status,
      appliedInset: Number.parseFloat(
        getComputedStyle(pane).getPropertyValue('--chat-composer-height'),
      ),
      expectedInset: Math.max(Math.ceil(composerRect.height), 72),
      scrollTop: transcript.scrollTop,
      scrollLeft: transcript.scrollLeft,
      windowScrollX: window.scrollX,
      windowScrollY: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      visibleTop: Math.max(0, port.top),
      visibleBottom: Math.min(window.innerHeight, port.bottom, composerRect.top),
      headingTop: heading.getBoundingClientRect().top,
      headingBottom: heading.getBoundingClientRect().bottom,
      items: [...list.querySelectorAll('li')].map((item) => ({
        top: item.getBoundingClientRect().top,
        bottom: item.getBoundingClientRect().bottom,
      })),
    }
  })
  expect(geometry.fonts).toBe('loaded')
  expect(geometry.appliedInset).toBe(geometry.expectedInset)
  expect(geometry.scrollTop).toBe(target.scrollTop)
  expect(geometry.width).toBe(target.width)
  expect(geometry.height).toBe(target.height)
  expect(geometry.scrollLeft).toBe(0)
  expect(geometry.windowScrollX).toBe(0)
  expect(geometry.windowScrollY).toBe(0)
  expect(geometry.headingTop).toBeGreaterThanOrEqual(geometry.visibleTop)
  expect(geometry.headingBottom).toBeLessThanOrEqual(geometry.visibleBottom)
  expect(geometry.items).toHaveLength(5)
  for (const item of geometry.items) {
    expect(item.top).toBeGreaterThanOrEqual(geometry.visibleTop)
    expect(item.bottom).toBeLessThanOrEqual(geometry.visibleBottom)
  }
}

describe('markdown bold after glob table cells', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedMarkdownBoldGlobFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders architecture list labels bold after table with glob paths', async () => {
    await $('.message-text h2').waitForExist({ timeout: 30_000 })

    const metrics = await browser.execute(() => {
      const root = document.querySelector('.message-text')
      if (!root) throw new Error('no message-text')

      const mcpItem = [...root.querySelectorAll('li')].find((li) =>
        li.textContent.includes('MCP host'),
      )
      const mcpStrong = mcpItem?.querySelector('strong')
      const globCell = root.querySelector('td strong code')
      const supportingHeading = [...root.querySelectorAll('h2')].find((h) =>
        h.textContent.includes('Key Supporting Files'),
      )
      const supportingList = supportingHeading?.nextElementSibling
      const supportingItems = supportingList ? [...supportingList.querySelectorAll('li')] : []

      const gap = (a: Element | null | undefined, b: Element | null | undefined): number => {
        if (!a || !b) return 0
        return b.getBoundingClientRect().top - a.getBoundingClientRect().bottom
      }

      return {
        mcpItemHtml: mcpItem?.innerHTML ?? '',
        mcpStrongText: mcpStrong?.textContent ?? '',
        hasLiteralMcpStars: (mcpItem?.textContent ?? '').includes('**'),
        hasMalformedStrong: root.innerHTML.includes('</strong>MCP host**'),
        globCellText: globCell?.textContent ?? '',
        architectureListLabels: [...root.querySelectorAll('h2')]
          .filter((h) => h.textContent.includes('Architecture Notes'))[0]
          ?.nextElementSibling?.querySelectorAll('li strong').length,
        supportingListItemCount: supportingItems.length,
        supportingItemGap: gap(supportingItems[0], supportingItems[1]),
      }
    })

    expect(metrics).not.toHaveProperty('error')
    expect(metrics.mcpStrongText).toBe('MCP host')
    expect(metrics.hasLiteralMcpStars).toBe(false)
    expect(metrics.hasMalformedStrong).toBe(false)
    expect(metrics.globCellText).toBe('src/**/*.test.ts')
    expect(metrics.architectureListLabels).toBe(5)
    expect(metrics.supportingListItemCount).toBe(3)
    expect(metrics.supportingItemGap).toBeLessThan(12)

    await assertNoErrorToasts('markdown bold glob fixture')

    await withCaptureFrame(async () => {
      await prepareMarkdownCapture('bottom')
      await browser.saveScreenshot(join(SCREENSHOT_DIR, 'markdown-bold-glob-full.png'))
    })

    await withCaptureFrame(async () => {
      await prepareMarkdownCapture('architecture')
      await browser.saveScreenshot(join(SCREENSHOT_DIR, 'markdown-bold-glob-architecture.png'))
    })
  })
})
