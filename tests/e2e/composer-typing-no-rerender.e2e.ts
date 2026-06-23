import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedBrowserLinkChatFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Regression for the "scroll + links flicker while typing" bug: the composer
// debounce-saves the draft, which used to emit the coarse `threads_changed`
// event and make the conversation view rebuild every message (clear + re-render
// markdown, re-resolve links, reset scroll) on each keystroke. We pin the actual
// message + link DOM nodes on `window` and verify they survive typing — node
// identity changing would mean the list was rebuilt.
describe('composer typing does not re-render the conversation', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedBrowserLinkChatFixture(process.cwd())
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('keeps existing message and link DOM nodes while typing a draft', async () => {
    const message = await $('[data-message-id="msg-assistant-link"] .message-text')
    await message.waitForDisplayed({ timeout: 30_000 })
    const link = await message.$('a')
    await link.waitForDisplayed({ timeout: 5_000 })

    // Pin the live nodes so we can compare identity after typing.
    await browser.execute(() => {
      const msg = document.querySelector('[data-message-id="msg-assistant-link"]')
      const anchor = msg?.querySelector('a') ?? null
      ;(window as unknown as Record<string, unknown>).__e2eMsgNode = msg
      ;(window as unknown as Record<string, unknown>).__e2eLinkNode = anchor
    })

    // Type in two bursts, pausing past the 250ms draft-save debounce each time so
    // multiple `thread_draft_changed` events fire — each of which previously
    // triggered a full conversation rebuild.
    const composer = await $('.prompt-input')
    await composer.click()
    await composer.addValue('investigating the flicker')
    await browser.pause(450)
    await composer.addValue(' while typing into chat')
    await browser.pause(450)

    const result = await browser.execute(() => {
      const win = window as unknown as Record<string, unknown>
      const msg = document.querySelector('[data-message-id="msg-assistant-link"]')
      const anchor = msg?.querySelector('a') ?? null
      return {
        sameMsgNode: win.__e2eMsgNode === msg,
        sameLinkNode: win.__e2eLinkNode === anchor,
        href: anchor?.getAttribute('href') ?? null,
        msgCount: document.querySelectorAll('.messages-list .msg').length,
        linkCount: document.querySelectorAll('.messages-list a[data-browser-link]').length,
      }
    })

    // Same node objects ⇒ the conversation was not torn down and rebuilt.
    expect(result.sameMsgNode).toBe(true)
    expect(result.sameLinkNode).toBe(true)
    expect(result.href).toContain('example.com')
    expect(result.msgCount).toBe(1)
    expect(result.linkCount).toBe(1)

    // Draft text is still in the composer (debounced save did not clear it).
    await expect(composer).toHaveValue('investigating the flicker while typing into chat')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'composer-typing-no-rerender.png'))
  })
})
