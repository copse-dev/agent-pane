import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { CURSOR_AGENTS_WEB_URL } from '../../src/shared/remote-agent.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('Cursor Cloud Agent settings list hint', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-cursor-agents-hint')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('explains Filter → Source → API and links to cursor.com/agents', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()

    const general = $('.settings-section[data-section="general"]')
    await expect(general).toBeDisplayed()

    // The Cursor cloud agent lives under the Cursor provider chip; select it,
    // then scroll the Providers block into view so the sticky footer does not
    // cover the hint.
    const cursorChip = general.$('.provider-chip[data-provider="cursor"]')
    await cursorChip.waitForExist({ timeout: 15_000 })
    await cursorChip.click()

    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('[data-testid="cursor-agents-list-hint"]')
        ?.closest('fieldset')
        ?.scrollIntoView({ block: 'center' })
    })

    const hint = general.$('[data-testid="cursor-agents-list-hint"]')
    await expect(hint).toBeDisplayed()
    const text = await hint.getText()
    assert.match(text, /Filter → Source → API/)
    assert.match(text, /cursor\.com\/agents/)

    const link = hint.$('a')
    await expect(link).toHaveAttribute('href', CURSOR_AGENTS_WEB_URL)
    await expect(link).toHaveAttribute('target', '_blank')

    await browser.pause(100)
    await saveElementScreenshot('#settings-dialog', 'settings-cursor-agents-hint.png')
  })
})
