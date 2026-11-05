import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedStickyUserPromptFixture } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { navigationTextOverlaps } from './helpers/scroll-to-bottom.ts'

describe('latest user prompt anchor', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
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
        throw new Error('missing sticky fixture element')
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
    // The previews grow through a max-width/max-height transition: capture
    // the settled full size, not a frame of the way there.
    let lastSizes = ''
    let stableReads = 0
    await browser.waitUntil(
      async () => {
        const sizes = await browser.execute(() =>
          [
            ...document.querySelectorAll<HTMLImageElement>(
              '[data-message-id="msg-user-sticky-latest"] .message-image',
            ),
          ]
            .map((image) => {
              const rect = image.getBoundingClientRect()
              return `${String(rect.width)}x${String(rect.height)}`
            })
            .join(','),
        )
        stableReads = sizes === lastSizes ? stableReads + 1 : 0
        lastSizes = sizes
        return stableReads >= 3
      },
      { timeout: 10_000, interval: 50, timeoutMsg: 'expected the full previews to stop resizing' },
    )
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
    const firstImage = images[0]
    if (!firstImage) throw new Error('Missing first prompt image')
    await browser.waitUntil(async () => (await firstImage.getSize('width')) > 100)
  })

  it('keeps a preview compact when its own shrink clamps the scroll position', async () => {
    const result = await browser.execute(async () => {
      const list = document.querySelector<HTMLElement>('.messages-list')
      const prompt = document.querySelector<HTMLElement>(
        '[data-message-id="msg-user-sticky-latest"]',
      )
      const previous = prompt?.previousElementSibling
      const image = prompt?.querySelector<HTMLImageElement>('.message-image')
      if (!list || !prompt || !previous || !image) throw new Error('sticky fixture is missing')

      list.scrollTop = 0
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          resolve()
        }),
      )
      await Promise.all(
        prompt
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      )
      const listStyle = getComputedStyle(list)
      const promptStyle = getComputedStyle(prompt)
      const stickyTop =
        list.getBoundingClientRect().top +
        Number.parseFloat(listStyle.paddingTop) +
        Number.parseFloat(promptStyle.top)
      const naturalTop =
        previous.getBoundingClientRect().bottom + Number.parseFloat(listStyle.rowGap)
      const thresholdScrollTop = naturalTop - stickyTop + list.scrollTop
      // Resize the conversation viewport so its bottom is just past the sticky
      // threshold. Compacting the image then shortens scrollHeight enough to
      // clamp scrollTop back across that threshold.
      const height = list.scrollHeight - thresholdScrollTop - 8
      if (height <= 0) throw new Error('sticky fixture cannot reach the boundary')
      list.style.flex = `0 0 ${String(height)}px`
      list.style.height = `${String(height)}px`
      const changes: boolean[] = []
      const observer = new MutationObserver(() => {
        changes.push(prompt.classList.contains('is-preview-compact'))
      })
      observer.observe(prompt, { attributes: true, attributeFilter: ['class'] })
      list.scrollTop = list.scrollHeight
      await new Promise((resolve) => setTimeout(resolve, 900))
      observer.disconnect()
      const result = {
        changes,
        compact: prompt.classList.contains('is-preview-compact'),
        imageWidth: image.getBoundingClientRect().width,
        atBottom: list.scrollHeight - list.clientHeight - list.scrollTop <= 1,
      }
      return result
    })
    try {
      expect(result.changes.length).toBeLessThanOrEqual(1)
      expect(result.compact).toBe(true)
      expect(result.imageWidth).toBeLessThanOrEqual(90)
      expect(result.atBottom).toBe(true)
      await saveAppScreenshot('user-prompt-previews-boundary.png')
    } finally {
      await browser.execute(() => {
        const list = document.querySelector<HTMLElement>('.messages-list')
        list?.style.removeProperty('flex')
        list?.style.removeProperty('height')
      })
    }
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
        throw new Error('missing narrow sticky fixture element')
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
    // In a narrow chat both navigation controls stay in their own row.
    expect(await navigationTextOverlaps()).toEqual([])

    await saveAppScreenshot('user-prompt-narrow-chat.png', { width: 600, height: 800 })
  })
})
