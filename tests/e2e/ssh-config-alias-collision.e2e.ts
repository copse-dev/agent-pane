import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedSshWorkspaceSettings } from './helpers/seed-config.ts'

describe('SSH config alias collisions', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-ssh-config-alias-collision')
    seedSshWorkspaceSettings({
      hosts: [
        {
          id: 'build-prod-d978ab5a',
          label: 'build.prod',
          host: 'build.prod',
        },
        {
          id: 'build-prod',
          label: 'build-prod',
          host: 'build-prod',
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows both imported aliases after their generated ids are disambiguated', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="ssh"]').click()

    const section = $('.settings-section[data-section="ssh"]')
    await expect(section).toBeDisplayed()
    const text = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>('.ssh-host-row')].map((row) => row.innerText),
    )
    assert.equal(text.length, 2)
    assert.ok(text.some((value) => value.includes('build.prod')))
    assert.ok(text.some((value) => value.includes('build-prod')))

    await saveElementScreenshot('#settings-dialog', 'ssh-config-alias-collision.png')
  })
})
