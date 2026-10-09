import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedStableWorkspace,
  seedTranscriptQuoteFixture,
} from './helpers/seed-config.ts'
import { prepareChatMessageScreenshot, saveAppScreenshot } from './helpers/screenshot.ts'
import { composerText, setComposerValue } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'

const MENU_SHOT = 'transcript-quote-context-menu.png'
const COMPOSER_SHOT = 'transcript-quote-composer-blockquote.png'
const SELECTION_SHOT = 'transcript-quote-selection-action.png'
const INLINE_COMPOSER_SHOT = 'transcript-quote-inline-reply.png'

const SELECTED_PHRASE = 'three modules'

/**
 * Select `text` inside `[data-message-id="msg-assistant-quote"] .message-body`
 * and dispatch a real right-click at it — mirrors what a user's mouse-drag +
 * right-click produces, without WebdriverIO's own (unsupported) selection API.
 */
async function rightClickSelectedText(text: string): Promise<void> {
  await browser.execute((needle) => {
    const container = document.querySelector<HTMLElement>(
      '[data-message-id="msg-assistant-quote"] .message-body',
    )
    if (!container) throw new Error('assistant message body not found')
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const value = node.nodeValue ?? ''
      const at = value.indexOf(needle)
      if (at !== -1) {
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + needle.length)
        const sel = window.getSelection()
        if (!sel) throw new Error('no window selection')
        sel.removeAllRanges()
        sel.addRange(range)
        const rect = range.getBoundingClientRect()
        node.parentElement?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.bottom,
          }),
        )
        return
      }
      node = walker.nextNode()
    }
    throw new Error(`text "${needle}" not found in the assistant message`)
  }, text)
}

/** Reach the action through a real mouse drag, without dispatching a menu or selection event. */
async function dragSelectText(text: string, expectedSelection = text): Promise<void> {
  const rect = await browser.execute((needle) => {
    const container = document.querySelector(
      '[data-message-id="msg-assistant-quote"] .message-body',
    )
    if (!container) throw new Error('assistant message body not found')
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const at = (node.nodeValue ?? '').indexOf(needle)
      if (at !== -1) {
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + needle.length)
        const rects = [...range.getClientRects()].filter(
          (rect) => rect.width > 0 && rect.height > 0,
        )
        const first = rects[0]
        const last = rects[rects.length - 1]
        if (!first || !last) throw new Error('selection phrase has no visible lines')
        return {
          left: first.left,
          startY: first.top + first.height / 2,
          right: last.right,
          endY: last.top + last.height / 2,
        }
      }
      node = walker.nextNode()
    }
    throw new Error('selection phrase not found')
  }, text)
  await browser
    .action('pointer')
    .move({ x: Math.round(rect.left), y: Math.round(rect.startY) })
    .down()
    .move({ x: Math.round(rect.right), y: Math.round(rect.endY), duration: 300 })
    .up()
    .perform()
  await browser.waitUntil(
    async () =>
      (await browser.execute(() =>
        [...(CSS.highlights.get('transcript-reply-selection') ?? [])]
          .map((range) => (range instanceof Range ? range.toString() : ''))
          .join(''),
      )) === expectedSelection,
    { timeout: 5_000, timeoutMsg: 'expected mouse drag to select the phrase' },
  )
}

async function expectReplyCaret(expectedText: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((text) => {
        const composer = document.querySelector('.prompt-input')
        const selection = document.getSelection()
        if (!composer || !selection || selection.rangeCount === 0) return false
        const range = selection.getRangeAt(0)
        if (!composer.contains(range.startContainer) || !selection.isCollapsed) return false
        const before = document.createRange()
        before.selectNodeContents(composer)
        before.setEnd(range.startContainer, range.startOffset)
        return document.activeElement === composer && before.toString() === text
      }, expectedText),
    { timeout: 5_000, timeoutMsg: 'expected a focused caret after the quote and blank separator' },
  )
}

describe('transcript selection: quote into the reply', () => {
  before(async () => {
    resetUserData()
    seedTranscriptQuoteFixture(seedStableWorkspace())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-quote"] .message-body').waitForExist({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('shows Quote in reply, Add to roadmap, Search and Copy for a selection', async () => {
    await rightClickSelectedText(SELECTED_PHRASE)

    const menu = $('.context-menu')
    await menu.waitForDisplayed({ timeout: 5_000 })
    const labels = await browser.execute(() =>
      [...document.querySelectorAll('.context-menu-item')].map((el) => el.textContent),
    )
    expect(labels).toEqual(['Quote in reply', 'Add to roadmap', 'Search', 'Copy'])

    await prepareChatMessageScreenshot()
    await saveAppScreenshot(MENU_SHOT)
  })

  it('inserts the selection as a markdown blockquote and focuses the composer', async () => {
    await rightClickSelectedText(SELECTED_PHRASE)
    await $('.context-menu-item=Quote in reply').click()

    const composer = $('.prompt-input')
    await browser.waitUntil(
      async () => (await composer.getText()).includes(`> ${SELECTED_PHRASE}`),
      { timeout: 5_000, timeoutMsg: 'expected the composer to contain the quoted selection' },
    )
    expect(await composer.getText()).toContain(`> ${SELECTED_PHRASE}`)
    const isFocused = await browser.execute(
      () => document.activeElement === document.querySelector('.prompt-input'),
    )
    expect(isFocused).toBe(true)

    await expectReplyCaret(`> ${SELECTED_PHRASE}\n\n`)
    await browser.keys('My reply.')
    expect(await composerText()).toBe(`> ${SELECTED_PHRASE}\n\nMy reply.`)
    await prepareChatMessageScreenshot()
    await saveAppScreenshot(COMPOSER_SHOT)
  })

  it('copies the highlighted passage after autofocus and prefers selected reply text', async () => {
    await setComposerValue('')
    await dragSelectText(SELECTED_PHRASE)
    const reply = $('.transcript-selection-reply')
    await reply.waitForDisplayed({ timeout: 5_000 })
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    for (const draft of ['', 'Keep this reply.']) {
      if (draft) await browser.keys(draft)
      await browser.execute(async () => navigator.clipboard.writeText('clipboard sentinel'))
      await browser.keys([modifier, 'c'])
      expect(await browser.execute(async () => navigator.clipboard.readText())).toBe(
        SELECTED_PHRASE,
      )
      expect(await reply.getValue()).toBe(draft)
      expect(
        await browser.execute(
          () => document.activeElement === document.querySelector('.transcript-selection-reply'),
        ),
      ).toBe(true)
    }
    await browser.keys([modifier, 'a'])
    await browser.keys([modifier, 'c'])
    expect(await browser.execute(async () => navigator.clipboard.readText())).toBe(
      'Keep this reply.',
    )
    await saveAppScreenshot('transcript-quote-copy-shortcut.png')
    await browser.keys('Escape')
  })

  it('keeps selected-text menu actions after inline reply autofocus', async () => {
    for (const draft of ['', 'Keep this reply.']) {
      await setComposerValue('')
      await dragSelectText(SELECTED_PHRASE)
      await $('.transcript-selection-reply').waitForDisplayed({ timeout: 5_000 })
      expect(
        await browser.execute(
          () => document.activeElement === document.querySelector('.transcript-selection-reply'),
        ),
      ).toBe(true)
      expect(await browser.execute(() => document.getSelection()?.toString())).toBe('')
      if (draft) await browser.keys(draft)
      await $('[data-message-id="msg-assistant-quote"] .message-body').click({ button: 'right' })
      await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
      expect(
        await browser.execute(() =>
          [...document.querySelectorAll('.context-menu-item')].map((item) => item.textContent),
        ),
      ).toEqual(['Quote in reply', 'Add to roadmap', 'Search', 'Copy'])
      expect(await browser.execute(() => document.getSelection()?.toString())).toBe(SELECTED_PHRASE)
      if (draft) {
        expect(await $('.transcript-selection-reply').getValue()).toBe(draft)
        await saveAppScreenshot('transcript-quote-autofocus-context-menu.png')
      }
      await browser.keys('Escape')
      await browser.keys('Escape')
    }
  })

  it('offers an inline action after mouse selection and types below a quote after an existing draft', async () => {
    await setComposerValue('Existing draft.')
    await dragSelectText(SELECTED_PHRASE)
    const action = $('.transcript-selection-quote')
    await action.waitForDisplayed({ timeout: 5_000 })
    expect(await $('.context-menu').isExisting()).toBe(false)
    const geometry = await browser.execute(() => {
      const button = document.querySelector('.transcript-selection-quote')
      const range = [...(CSS.highlights.get('transcript-reply-selection') ?? [])][0]
      if (!button || !(range instanceof Range)) throw new Error('selection action missing')
      const actionRect = button.getBoundingClientRect()
      const selectionRect = range.getBoundingClientRect()
      return {
        visible: actionRect.left >= 0 && actionRect.right <= window.innerWidth,
        nearSelection:
          actionRect.bottom <= selectionRect.top || actionRect.top >= selectionRect.bottom,
        gap:
          actionRect.bottom <= selectionRect.top
            ? selectionRect.top - actionRect.bottom
            : actionRect.top - selectionRect.bottom,
      }
    })
    expect(geometry.visible).toBe(true)
    expect(geometry.nearSelection).toBe(true)
    expect(geometry.gap).toBeLessThanOrEqual(8)
    const compactHeight = await browser.execute(() => {
      const popup = document.querySelector<HTMLElement>('.transcript-selection-quote')
      const input = document.querySelector<HTMLTextAreaElement>('.transcript-selection-reply')
      if (!popup || !input) throw new Error('selection reply missing')
      return {
        popup: popup.getBoundingClientRect().height,
        input: input.getBoundingClientRect().height,
      }
    })
    expect(compactHeight.popup).toBeLessThanOrEqual(50)
    expect(compactHeight.input).toBeLessThanOrEqual(30)
    await prepareChatMessageScreenshot()
    await saveAppScreenshot(SELECTION_SHOT)

    expect(await action.getText()).not.toContain(SELECTED_PHRASE)
    expect(
      await browser.execute(
        () =>
          document.querySelector('.transcript-selection-quote')?.querySelectorAll('button').length,
      ),
    ).toBe(1)
    expect(await $('.transcript-selection-send').getText()).toBe('Send')
    expect(await action.getText()).toBe('Send')
    const reply = $('.transcript-selection-reply')
    expect(
      await browser.execute(
        () => document.activeElement === document.querySelector('.transcript-selection-reply'),
      ),
    ).toBe(true)
    await browser.keys('Ship these first.')
    expect(await reply.getValue()).toBe('Ship these first.')
    expect(
      await browser.execute(() => CSS.highlights.get('transcript-reply-selection')?.size),
    ).toBe(1)
    await saveAppScreenshot('transcript-quote-selection-reply.png')
    await browser.keys('Enter')
    expect(await browser.execute(() => CSS.highlights.has('transcript-reply-selection'))).toBe(
      false,
    )
    const expected = `Existing draft.\n\n> ${SELECTED_PHRASE}\n\nShip these first.`
    await expectReplyCaret(expected)
    expect(await composerText()).toBe(expected)
    expect(await action.isDisplayed()).toBe(false)
    await prepareChatMessageScreenshot()
    await saveAppScreenshot(INLINE_COMPOSER_SHOT)
  })

  it('grows the selection reply while typing multiple lines', async () => {
    await dragSelectText(SELECTED_PHRASE)
    const popup = $('.transcript-selection-quote')
    await popup.waitForDisplayed({ timeout: 5_000 })
    const initialHeight = await browser.execute(() => {
      const element = document.querySelector('.transcript-selection-quote')
      if (!element) throw new Error('selection reply missing')
      return element.getBoundingClientRect().height
    })
    await browser.keys('Please inspect where this rule is selected.')
    await browser.keys(['Shift', 'Enter'])
    await browser.keys('Then resolve it before creating the provider.')
    const expanded = await browser.execute(() => {
      const element = document.querySelector<HTMLElement>('.transcript-selection-quote')
      const input = document.querySelector<HTMLTextAreaElement>('.transcript-selection-reply')
      if (!element || !input) throw new Error('selection reply missing')
      return {
        popupHeight: element.getBoundingClientRect().height,
        inputHeight: input.getBoundingClientRect().height,
        text: input.value,
        scrollHeight: input.scrollHeight,
      }
    })
    expect(expanded.text).toContain('\n')
    expect(expanded.popupHeight).toBeGreaterThan(initialHeight)
    expect(expanded.inputHeight).toBeGreaterThan(30)
    expect(expanded.inputHeight).toBeGreaterThanOrEqual(expanded.scrollHeight - 2)
    await saveAppScreenshot('transcript-quote-selection-reply-expanded.png')
    // A draft keeps the reply open; dismiss it so later drags start from a clean selection.
    await browser.keys('Escape')
    await popup.waitForDisplayed({ reverse: true, timeout: 5_000 })
  })

  it('dismisses the inline action on Escape and selection collapse', async () => {
    await dragSelectText(SELECTED_PHRASE)
    const action = $('.transcript-selection-quote')
    await action.waitForDisplayed({ timeout: 5_000 })
    await browser.keys('Escape')
    await action.waitForDisplayed({ reverse: true, timeout: 5_000 })
    await dragSelectText(SELECTED_PHRASE)
    await action.waitForDisplayed({ timeout: 5_000 })
    await $('[data-message-id="msg-user-quote"] .message-body').click()
    await action.waitForDisplayed({ reverse: true, timeout: 5_000 })
  })

  it('keeps a typed reply open until Escape or deleting its text', async () => {
    await dragSelectText(SELECTED_PHRASE)
    const popup = $('.transcript-selection-quote')
    const reply = $('.transcript-selection-reply')
    await popup.waitForDisplayed({ timeout: 5_000 })
    await browser.keys('Keep this reply while I check the conversation.')
    await $('[data-message-id="msg-user-quote"] .message-body').click()
    expect(await popup.isDisplayed()).toBe(true)
    expect(await reply.getValue()).toBe('Keep this reply while I check the conversation.')
    await dragSelectText('feature flag', SELECTED_PHRASE)
    expect(await popup.isDisplayed()).toBe(true)
    expect(await reply.getValue()).toBe('Keep this reply while I check the conversation.')
    expect(
      await browser.execute(() =>
        [...(CSS.highlights.get('transcript-reply-selection') ?? [])]
          .map((range) => (range instanceof Range ? range.toString() : ''))
          .join(''),
      ),
    ).toBe(SELECTED_PHRASE)
    await browser.execute(() => {
      document.querySelector('.messages-list')?.dispatchEvent(new Event('scroll'))
      window.dispatchEvent(new Event('blur'))
    })
    expect(await popup.isDisplayed()).toBe(true)
    expect(await $('.transcript-selection-send').getText()).toBe('Send')
    expect(await popup.getText()).toBe('Send')
    await saveAppScreenshot('transcript-quote-sticky-reply.png')
    await browser.keys('Escape')
    await popup.waitForDisplayed({ reverse: true, timeout: 5_000 })

    await dragSelectText(SELECTED_PHRASE)
    await popup.waitForDisplayed({ timeout: 5_000 })
    await browser.keys('Delete this reply.')
    await reply.click()
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'a'])
    await browser.keys('Backspace')
    await popup.waitForDisplayed({ reverse: true, timeout: 5_000 })
    expect(await reply.getValue()).toBe('')
  })

  it('keeps a multiline highlight clear while the focused reply is open', async () => {
    await setComposerValue('')
    const phrase = 'three modules and should ship behind a feature flag.'
    await browser.execute(() => {
      const body = document.querySelector<HTMLElement>(
        '[data-message-id="msg-assistant-quote"] .message-body',
      )
      if (!body) throw new Error('assistant message body not found')
      body.style.maxWidth = '280px'
    })
    try {
      await dragSelectText(phrase)
      const popup = $('.transcript-selection-quote')
      await popup.waitForDisplayed({ timeout: 5_000 })
      const geometry = await browser.execute(() => {
        const reply = document.querySelector('.transcript-selection-quote')
        const range = [...(CSS.highlights.get('transcript-reply-selection') ?? [])][0]
        if (!reply || !(range instanceof Range)) throw new Error('selection reply missing')
        const popupRect = reply.getBoundingClientRect()
        const lines = [...range.getClientRects()].filter(
          (rect) => rect.width > 0 && rect.height > 0,
        )
        return {
          lineCount: lines.length,
          clear: lines.every(
            (line) => popupRect.bottom <= line.top || popupRect.top >= line.bottom,
          ),
          focused: document.activeElement === reply.querySelector('textarea'),
          buttons: reply.querySelectorAll('button').length,
        }
      })
      expect(geometry.lineCount).toBeGreaterThanOrEqual(2)
      expect(geometry.clear).toBe(true)
      expect(geometry.focused).toBe(true)
      expect(geometry.buttons).toBe(1)
      await browser.keys('Ship these together.')
      await saveAppScreenshot('transcript-quote-multiline-reply.png')
      await browser.keys('Enter')
      expect(await composerText()).toBe(`> ${phrase}\n\nShip these together.`)
      await expectReplyCaret(`> ${phrase}\n\nShip these together.`)
    } finally {
      await browser.execute(() => {
        document
          .querySelector<HTMLElement>('[data-message-id="msg-assistant-quote"] .message-body')
          ?.style.removeProperty('max-width')
      })
    }
  })

  it('sends the selected quote and reply immediately with the platform shortcut', async () => {
    await setComposerValue('')
    await installMockScenario({
      title: 'Reply to selected transcript text',
      turns: [
        {
          user: `> ${SELECTED_PHRASE}\n\nSend this reply now.`,
          responses: [{ text: 'I will use those modules.' }],
        },
      ],
    })
    await dragSelectText(SELECTED_PHRASE)
    await $('.transcript-selection-reply').waitForDisplayed({ timeout: 5_000 })
    await browser.keys('Send this reply now.')
    expect(await $('.transcript-selection-reply').getValue()).toBe('Send this reply now.')
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'Enter'])
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          [...document.querySelectorAll('.msg-user .message-text')].some((message) =>
            (message.textContent ?? '').includes('Send this reply now.'),
          ),
        ),
      { timeout: 10_000, timeoutMsg: 'expected the inline reply in the real transcript' },
    )
    const sent = await browser.execute(
      () =>
        [...document.querySelectorAll('.msg-user .message-text')].find((message) =>
          (message.textContent ?? '').includes('Send this reply now.'),
        )?.textContent,
    )
    expect(sent).toContain(SELECTED_PHRASE)
    expect(await composerText()).toBe('')
    await $('.transcript-selection-quote').waitForDisplayed({ reverse: true, timeout: 5_000 })
    await expectAssistantReply('I will use those modules.')
    await prepareChatMessageScreenshot()
    await saveAppScreenshot('transcript-quote-instant-reply.png')
  })
})
