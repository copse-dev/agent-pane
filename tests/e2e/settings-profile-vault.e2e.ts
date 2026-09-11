import { $, browser, expect } from '@wdio/globals'
import { randomBytes, randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { createVaultManifest, newVaultIdentity } from '@copse/store-kit/profile-vault-crypto.ts'
import { readVaultSource, writeVaultFile } from '@copse/store-kit/profile-vault-files.ts'
import { copseUserDataDir } from '../../src/main/services/storage/copse-paths.ts'
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
    rmSync(join(copseUserDataDir(), 'vault-manifest.json'), { force: true })
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
  it('opens an encrypted profile locked when automatic startup authentication is unavailable', async () => {
    const userData = copseUserDataDir()
    const key = randomBytes(32)
    const manifest = createVaultManifest(key, newVaultIdentity(), randomUUID(), 'c3ludGhldGlj')
    key.fill(0)
    writeVaultFile(
      userData,
      'settings.json',
      JSON.stringify({
        ...readVaultSource(userData, 'settings.json'),
        savedSecretEncryption: { version: 1, profileId: manifest.profileId, keyId: manifest.keyId },
      }),
    )
    writeVaultFile(userData, 'vault-manifest.json', JSON.stringify(manifest))
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="storage"]').click()
    const section = $('.profile-vault-section')
    await expect(section).toHaveAttribute('data-state', 'unavailable')
    await expect(section).toHaveText(
      expect.stringContaining('Saved secrets are encrypted and locked.'),
    )
    await expect(section.$('button=Enable encryption')).not.toExist()
    await expect(section.$('input[type="password"]')).not.toExist()
    await saveElementScreenshot('.profile-vault-section', 'settings-vault-startup-unavailable.png')
  })
})
