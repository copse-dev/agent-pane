import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

/** Real main/preload IPC in the unsigned e2e shell; never requests authentication. */
describe('saved-secret encryption IPC', () => {
  before(async () => {
    writeE2eEnv({ COPSE_E2E_SECRET_STORAGE: 'unavailable' })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-profile-vault')
    await browser.reloadSession()
  })
  after(() => {
    writeE2eEnv({ COPSE_E2E_SECRET_STORAGE: undefined })
    resetUserData()
  })
  it('reports unavailable without offering setup when the signed helper is absent', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="storage"]').click()
    const section = $('.profile-vault-section')
    await expect(section).toHaveAttribute('data-state', 'unavailable')
    await expect(section).toHaveText(expect.stringContaining('signed Copse encryption helper'))
    await expect(section.$('button=Enable encryption')).not.toExist()
    await expect(section.$('input[type="password"]')).not.toExist()
    await saveElementScreenshot('.profile-vault-section', 'settings-vault-unavailable.png')
  })
})
