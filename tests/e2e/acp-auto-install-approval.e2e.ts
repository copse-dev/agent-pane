import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

describe('ACP adapter auto-install approval', () => {
  let originalPath = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-acp-auto-install-approval', {
      windowBounds: { width: 1280, height: 800 },
    })
    originalPath = process.env.PATH ?? ''
    writeE2eEnv({ PATH: '/usr/bin:/bin' })
    await browser.reloadSession()
  })

  after(async () => {
    writeE2eEnv({ PATH: originalPath })
    resetUserData()
  })

  it('discloses the possible global Socket Firewall install', async function () {
    this.timeout(60_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 10_000 })
    await $('.settings-nav-btn[data-section="experimental"]').click()
    await $('#settings-acp-agents-host .acp-known-list').waitForExist({ timeout: 10_000 })
    // Approval prompts intentionally queue behind the Settings modal.
    await $('.settings-close-btn').click()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Install ACP adapters globally?')

    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('@agentclientprotocol/codex-acp')
    expect(body).toContain('Socket Firewall (sfw)')
    expect(body).toContain('first install it globally')
    expect(body).toContain('lifecycle scripts disabled')

    await saveElementScreenshot('#approval-dialog', 'acp-auto-install-approval.png')
    await dialog.$('.approval-reject').click()
  })
})
