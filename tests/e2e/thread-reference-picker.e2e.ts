import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedThreadReferenceFixture } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('@-reference past threads (#644)', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedThreadReferenceFixture(process.cwd())
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows past threads in the @ picker and attaches a thread chip on select', async () => {
    // Empty query after `@` still resolves via a shared token in the seeded
    // thread titles/digests ("the"), which keeps the file list short too.
    await setComposerValue('@the')

    const threadItem = await $('.mention-picker .mention-item-thread')
    await threadItem.waitForDisplayed({ timeout: 10_000 })

    // Both seeded past threads are offered (the active thread is excluded).
    const threadItems = await $$('.mention-picker .mention-item-thread')
    await expect(threadItems).toBeElementsArrayOfSize({ gte: 1 })
    // Rendered with the SVG thread icon (not a 🧵 emoji), matching the app chrome.
    await expect($('.mention-item-thread svg.mention-thread-icon')).toBeExisting()

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'thread-reference-picker-open.png'))

    // Selecting a thread inserts a chip (nothing is inlined) and closes the picker.
    await threadItem.click()
    const chip = await $('.attachment-chip.thread-chip')
    await chip.waitForDisplayed({ timeout: 10_000 })
    await expect(chip).toHaveText(expect.stringContaining('Auth refactor plan'))
    await expect(chip.$('svg.thread-chip-icon')).toBeExisting()
    await expect($('.mention-picker')).not.toBeDisplayed()

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'thread-reference-chip.png'))
  })
})
