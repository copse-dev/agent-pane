import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedStreamingMarkdownFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('markdown streaming list pending', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedStreamingMarkdownFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders lazy continuations inside the open list item without raw leading dashes', async () => {
    await $('[data-message-id="streaming-markdown-message"] .message-text').waitForDisplayed({
      timeout: 30_000,
    })

    const result = await browser.execute(() => {
      const text = document.querySelector(
        '[data-message-id="streaming-markdown-message"] .message-text',
      )
      if (!text) return { error: 'no visible assistant message' }
      text.classList.add('streaming-markdown', 'is-streaming')
      text.innerHTML = [
        '<div class="stream-complete">',
        '<ul><li>Database migration ran flawlessly<span class="stream-pending stream-pending-list-continuation stream-pending-block">  - zero downtime during production rollout.</span></li></ul>',
        '</div>',
      ].join('')

      const li = text.querySelector('li')
      const continuation = text.querySelector('.stream-pending-list-continuation')
      return {
        liText: li?.textContent ?? '',
        continuationText: continuation?.textContent ?? '',
        hasFakeListItem: !!text.querySelector('.stream-pending-list-item'),
        hasRawDashPrefix: /^- /.test(continuation?.textContent ?? ''),
      }
    })

    expect(result).not.toHaveProperty('error')
    expect(result.hasFakeListItem).toBe(false)
    expect(result.continuationText).toContain('- zero downtime')
    expect(result.liText).toContain('Database migration ran flawlessly')
    expect(result.liText).toContain('zero downtime')

    await expect($('.stream-pending')).toBeDisplayed()
    const visible = await browser.execute(() => {
      const element = document.querySelector('.stream-pending')
      if (!element) return false
      const rect = element.getBoundingClientRect()
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= 0 &&
        rect.bottom <= innerHeight &&
        element.contains(
          document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
        )
      )
    })
    expect(visible).toBe(true)
    await saveAppScreenshot('markdown-streaming-list-continuation.png')
  })

  it('renders pending list items with native ul/li bullets matching committed items', async () => {
    await $('[data-message-id="streaming-markdown-message"] .message-text').waitForDisplayed({
      timeout: 30_000,
    })

    const result = await browser.execute(() => {
      const text = document.querySelector(
        '[data-message-id="streaming-markdown-message"] .message-text',
      )
      if (!text) return { error: 'no visible assistant message' }
      text.classList.add('streaming-markdown', 'is-streaming')
      text.innerHTML = [
        '<div class="stream-complete">',
        '<ul><li>First item</li><li class="stream-pending stream-pending-list-item stream-pending-block">Second item</li></ul>',
        '</div>',
      ].join('')

      const items = [...text.querySelectorAll('li')]
      const pending = text.querySelector('li.stream-pending-list-item')
      const ul = text.querySelector('ul')
      return {
        itemCount: items.length,
        pendingTag: pending?.tagName ?? '',
        pendingParentTag: pending?.parentElement?.tagName ?? '',
        ulChildTags: [...(ul?.children ?? [])].map((el) => el.tagName),
        hasCustomBulletBefore: pending
          ? getComputedStyle(pending, '::before').content !== 'none' &&
            getComputedStyle(pending, '::before').content !== 'normal'
          : false,
        listStyleType: ul ? getComputedStyle(ul).listStyleType : '',
      }
    })

    expect(result).not.toHaveProperty('error')
    expect(result.itemCount).toBe(2)
    expect(result.pendingTag).toBe('LI')
    expect(result.pendingParentTag).toBe('UL')
    expect(result.ulChildTags).toEqual(['LI', 'LI'])
    expect(result.hasCustomBulletBefore).toBe(false)
    expect(result.listStyleType).toBe('disc')

    await expect($('.stream-pending')).toBeDisplayed()
    const visible = await browser.execute(() => {
      const element = document.querySelector('.stream-pending')
      if (!element) return false
      const rect = element.getBoundingClientRect()
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= 0 &&
        rect.bottom <= innerHeight &&
        element.contains(
          document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
        )
      )
    })
    expect(visible).toBe(true)
    await saveAppScreenshot('markdown-streaming-list-pending-bullet.png')
  })
})
