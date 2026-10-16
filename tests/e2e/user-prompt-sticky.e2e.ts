import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedStickyUserPromptFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('latest user prompt anchor', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedStickyUserPromptFixture(process.cwd())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-sticky-result"] .message-text').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('right-aligns user bubbles and keeps only the latest prompt visible at the top', async () => {
    await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (list) list.scrollTop = list.scrollHeight
    })
    await browser.pause(100)

    const layout = await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      const first = document.querySelector('[data-message-id="msg-user-sticky-first"]')
      const latest = document.querySelector('[data-message-id="msg-user-sticky-latest"]')
      const machine = document.querySelector('[data-message-id="msg-user-sticky-machine"]')
      const answer = document.querySelector('[data-message-id="msg-assistant-sticky-result"]')
      const composer = document.getElementById('input-bar')
      const prompt = document.querySelector('.prompt-input')
      const footer = document.querySelector('.input-footer')
      if (!list || !first || !latest || !machine || !answer || !composer || !prompt || !footer) {
        return { error: 'missing sticky fixture element' }
      }

      const listRect = list.getBoundingClientRect()
      const firstRect = first.getBoundingClientRect()
      const latestRect = latest.getBoundingClientRect()
      const answerRect = answer.getBoundingClientRect()
      const userMessages = [...list.querySelectorAll('.msg-user')]
      const before = getComputedStyle(composer, '::before')
      return {
        listTop: listRect.top,
        listBottom: listRect.bottom,
        listPaddingTop: Number.parseFloat(getComputedStyle(list).paddingTop),
        firstBottom: firstRect.bottom,
        latestTop: latestRect.top,
        latestBottom: latestRect.bottom,
        rightEdgeDelta: Math.abs(latestRect.right - answerRect.right),
        latestPosition: getComputedStyle(latest).position,
        machinePosition: getComputedStyle(machine).position,
        machineClassList: machine.classList.contains('msg-machine-origin'),
        stickyUserCount: userMessages.filter(
          (message) => getComputedStyle(message).position === 'sticky',
        ).length,
        scrollable: list.scrollHeight > list.clientHeight,
        composerBackground: getComputedStyle(composer).backgroundColor,
        composerBeforeContent: before.content,
        composerShadow: getComputedStyle(composer).boxShadow,
        promptBackground: getComputedStyle(prompt).backgroundColor,
        footerBackground: getComputedStyle(footer).backgroundColor,
      }
    })

    expect(layout).not.toHaveProperty('error')
    expect(layout.scrollable).toBe(true)
    expect(layout.latestPosition).toBe('sticky')
    // A machine-originated turn never claims the anchor: it renders with its
    // marker but stays in transcript flow so the last human prompt stays pinned.
    expect(layout.machineClassList).toBe(true)
    expect(layout.machinePosition).toBe('relative')
    expect(layout.stickyUserCount).toBe(1)
    expect(layout.composerBackground).not.toBe('rgba(0, 0, 0, 0)')
    expect(layout.promptBackground).toBe('rgba(0, 0, 0, 0)')
    expect(layout.footerBackground).toBe('rgba(0, 0, 0, 0)')
    expect(layout.composerBeforeContent).toBe('none')
    expect(layout.composerShadow).not.toBe('none')
    expect(
      Math.abs(layout.latestTop - (layout.listTop + layout.listPaddingTop - 16)),
    ).toBeLessThanOrEqual(1)
    expect(layout.latestBottom).toBeLessThan(layout.listBottom)
    expect(layout.firstBottom).toBeLessThan(layout.listTop)
    expect(layout.rightEdgeDelta).toBeLessThanOrEqual(1)

    await saveAppScreenshot('user-prompt-sticky.png')
  })

  it('shrinks attached previews only while the latest prompt is pinned', async () => {
    const latest = $('[data-message-id="msg-user-sticky-latest"]')
    const images = latest.$$('.message-image')
    await expect(images).toBeElementsArrayOfSize(2)

    async function scrollPromptIntoFlow(): Promise<void> {
      await browser.execute(() => {
        const list = document.querySelector<HTMLElement>('.messages-list')
        const prompt = document.querySelector<HTMLElement>(
          '[data-message-id="msg-user-sticky-latest"]',
        )
        const previous = prompt?.previousElementSibling
        if (!list || !previous) throw new Error('sticky preview fixture is missing')
        const gap = Number.parseFloat(getComputedStyle(list).rowGap)
        list.scrollTop +=
          previous.getBoundingClientRect().bottom + gap - list.getBoundingClientRect().top - 96
      })
    }

    await scrollPromptIntoFlow()
    await browser.waitUntil(
      async () => !(await latest.getAttribute('class'))?.includes('is-preview-compact'),
    )
    await browser.waitUntil(async () => {
      const sizes = await browser.execute(() =>
        [
          ...document.querySelectorAll<HTMLImageElement>(
            '[data-message-id="msg-user-sticky-latest"] .message-image',
          ),
        ].map((image) => ({
          width: image.getBoundingClientRect().width,
          height: image.getBoundingClientRect().height,
        })),
      )
      return sizes.length === 2 && sizes.every((size) => size.width > 100 && size.height > 100)
    })
    const fullSize = await browser.execute(() =>
      [
        ...document.querySelectorAll<HTMLImageElement>(
          '[data-message-id="msg-user-sticky-latest"] .message-image',
        ),
      ].map((image) => ({
        width: image.getBoundingClientRect().width,
        height: image.getBoundingClientRect().height,
      })),
    )
    expect(fullSize.every((size) => size.width > 100 && size.height > 100)).toBe(true)
    const motion = await browser.execute(() => {
      const image = document.querySelector<HTMLImageElement>(
        '[data-message-id="msg-user-sticky-latest"] .message-image',
      )
      if (!image) throw new Error('sticky preview image is missing')
      const style = getComputedStyle(image)
      return {
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        properties: style.transitionProperty,
        duration: style.transitionDuration,
      }
    })
    if (!motion.reduced) {
      expect(motion.properties).toContain('max-width')
      expect(motion.properties).toContain('max-height')
      expect(motion.duration).not.toBe('0s')
    }
    await saveAppScreenshot('user-prompt-previews-full.png')

    await browser.execute(() => {
      const list = document.querySelector<HTMLElement>('.messages-list')
      if (list) list.scrollTop = list.scrollHeight
    })
    await browser.waitUntil(
      async () => (await latest.getAttribute('class'))?.includes('is-preview-compact') === true,
    )
    await browser.waitUntil(async () => {
      const sizes = await browser.execute(() =>
        [
          ...document.querySelectorAll<HTMLImageElement>(
            '[data-message-id="msg-user-sticky-latest"] .message-image',
          ),
        ].map((image) => ({
          width: image.getBoundingClientRect().width,
          height: image.getBoundingClientRect().height,
        })),
      )
      return sizes.length === 2 && sizes.every((size) => size.width <= 90 && size.height <= 66)
    })
    const pinnedText = await latest.$('.message-text').getText()
    expect(pinnedText).toContain('keep this latest request visible')
    await saveAppScreenshot('user-prompt-previews-pinned.png')

    await images[0]?.click()
    await expect($('dialog.attachment-preview-dialog[open]')).toExist()
    await $('.attachment-preview-close').click()

    await scrollPromptIntoFlow()
    await browser.waitUntil(
      async () => !(await latest.getAttribute('class'))?.includes('is-preview-compact'),
    )
    await browser.waitUntil(async () => (await images[0]?.getSize('width')) > 100)
  })

  it('returns the latest prompt to the transcript when the chat pane is narrow', async () => {
    await browser.execute(() => {
      const app = document.getElementById('app')
      if (app) app.style.width = '600px'
      window.dispatchEvent(new Event('resize'))
      const answer = document.querySelector('[data-message-id="msg-assistant-sticky-result"]')
      answer?.scrollIntoView({ block: 'end' })
    })
    await browser.pause(100)

    const layout = await browser.execute(() => {
      const chat = document.getElementById('pane-chat')
      const list = document.querySelector('.messages-list')
      const latest = document.querySelector('[data-message-id="msg-user-sticky-latest"]')
      const answer = document.querySelector('[data-message-id="msg-assistant-sticky-result"]')
      const composer = document.getElementById('input-bar')
      if (!chat || !list || !latest || !answer || !composer) {
        return { error: 'missing narrow sticky fixture element' }
      }

      const chatRect = chat.getBoundingClientRect()
      const listRect = list.getBoundingClientRect()
      const latestRect = latest.getBoundingClientRect()
      const answerRect = answer.getBoundingClientRect()
      const composerRect = composer.getBoundingClientRect()
      return {
        chatWidth: chatRect.width,
        latestPosition: getComputedStyle(latest).position,
        latestBottom: latestRect.bottom,
        answerTop: answerRect.top,
        answerBottom: answerRect.bottom,
        visibleTop: listRect.top,
        visibleBottom: Math.min(listRect.bottom, composerRect.top),
      }
    })

    expect(layout).not.toHaveProperty('error')
    expect(layout.chatWidth).toBeLessThanOrEqual(360)
    expect(layout.latestPosition).toBe('relative')
    expect(
      await $('[data-message-id="msg-user-sticky-latest"]').getAttribute('class'),
    ).not.toContain('is-preview-compact')
    expect(layout.latestBottom).toBeLessThanOrEqual(layout.answerTop)
    expect(layout.answerBottom).toBeGreaterThan(layout.visibleTop)
    expect(layout.answerBottom).toBeLessThanOrEqual(layout.visibleBottom + 1)

    await saveAppScreenshot('user-prompt-narrow-chat.png', { width: 600, height: 800 })
  })
})
