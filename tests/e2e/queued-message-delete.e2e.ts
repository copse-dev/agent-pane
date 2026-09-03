import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const QUEUED_TEXT = 'Then add unit tests for the parser.'

describe('queued message delete', function () {
  this.timeout(90_000)

  afterEach(() => {
    resetUserData()
  })

  it('removes a queued follow-up from the pinned panel', async function () {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-queued-delete', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    await setComposerValue('Refactor the JSON parser. [[mock:delay_ms 6000]]')
    await $('.submit-btn').click()
    await browser.waitUntil(async () => (await $('.stop-btn').getProperty('hidden')) !== true, {
      timeout: 10_000,
    })

    await browser.execute((value: string) => {
      const input = document.querySelector('.prompt-input') as HTMLElement | null
      const btn = document.querySelector('.submit-btn') as HTMLButtonElement | null
      if (input) input.textContent = value
      btn?.click()
    }, QUEUED_TEXT)

    await $('.conversation-queued .msg-queued').waitForExist({ timeout: 5_000 })
    await expect($('.conversation-queued .message-text')).toHaveText(QUEUED_TEXT)
    await expect($('.queued-delete')).toExist()

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'queued-message-delete-before.png'))

    // The filled "Send now" sits between two outlined chips and must not read
    // larger than them. All three are the same box, so the compensation is in
    // paint: the fill is clipped to the padding box instead of spilling into
    // the border edge (docs/ui-taste.md, input-bar.css). The full-window shot
    // above cannot show a 1px inset, so capture the row on its own as well.
    const clips = await browser.execute(() =>
      [...document.querySelectorAll('.conversation-queued .queued-action')].map((chip) => ({
        label: chip.textContent,
        clip: getComputedStyle(chip).backgroundClip,
        height: chip.getBoundingClientRect().height,
      })),
    )
    await expect(clips.map((chip) => `${chip.label ?? ''}:${chip.clip}`)).toEqual([
      'Edit:border-box',
      'Send now:padding-box',
      'Delete:border-box',
    ])
    // The clip only compensates while the boxes really are identical.
    await expect(new Set(clips.map((chip) => chip.height)).size).toBe(1)
    await saveElementScreenshot(
      '.conversation-queued .message-queued-actions',
      'queued-actions-row.png',
    )

    await $('.queued-delete').click()

    await browser.waitUntil(
      async () => (await $('.conversation-queued').getProperty('hidden')) === true,
      { timeout: 5_000 },
    )
    await expect($('.message-queued-badge')).not.toExist()
    await expect($('.footer-queue')).toHaveProperty('hidden', true)

    const userMessages = await $$('.messages-list .msg-user .message-text')
    await expect(userMessages).toHaveLength(1)
    await expect(userMessages[0]).toHaveText('Refactor the JSON parser. [[mock:delay_ms 6000]]')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'queued-message-delete-after.png'))
  })
})
