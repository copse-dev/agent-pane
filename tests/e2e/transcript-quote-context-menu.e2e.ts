import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedTranscriptQuoteFixture } from './helpers/seed-config.ts'
import { prepareChatMessageScreenshot, saveAppScreenshot } from './helpers/screenshot.ts'

const MENU_SHOT = 'transcript-quote-context-menu.png'
const COMPOSER_SHOT = 'transcript-quote-composer-blockquote.png'

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

describe('transcript right-click: quote a selection into the reply', () => {
  before(async () => {
    resetUserData()
    seedTranscriptQuoteFixture(process.cwd())
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

    await prepareChatMessageScreenshot()
    await saveAppScreenshot(COMPOSER_SHOT)
  })
})
