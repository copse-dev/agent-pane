import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { installFakeSshHost, type FakeSshHost } from './helpers/fake-ssh.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedEmptyProject,
  seedSshWorkspaceSettings,
  seedStableWorkspace,
} from './helpers/seed-config.ts'

// A fixed path, because the breadcrumbs show it in the screenshots.
const REMOTE_HOME = join(tmpdir(), 'copse-e2e-browse-start', 'dev')

async function openRemoteFolderDialog(): Promise<WebdriverIO.Element> {
  await $('.projects-add-btn').click()
  await $('.context-menu-item*=Open remote project').click()
  const dialog = await $('#remote-folder-dialog').getElement()
  await expect(dialog).toBeDisplayed()
  return dialog
}

/** Wait until the dialog lists `crumb`, then return the folder names it shows. */
async function listing(crumb: string): Promise<string[]> {
  const current = $('#remote-folder-dialog .remote-folder-crumb-current')
  await browser.waitUntil(async () => (await current.getText()) === crumb, {
    timeout: 15_000,
    timeoutMsg: `the dialog never listed ${crumb}`,
  })
  await $('#remote-folder-dialog .remote-folder-entry').waitForExist({ timeout: 10_000 })
  return browser.execute(() =>
    [...document.querySelectorAll('#remote-folder-dialog .remote-folder-entry')].map((entry) =>
      entry.textContent.trim(),
    ),
  )
}

describe('Open remote folder — where browsing starts', () => {
  let host: FakeSshHost

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    host = installFakeSshHost({ remoteHome: REMOTE_HOME })
    for (const dir of ['notes', 'projects/api', 'projects/web']) {
      mkdirSync(join(REMOTE_HOME, dir), { recursive: true })
    }
    seedEmptyProject(seedStableWorkspace(), 'e2e-remote-folder-browse-start')
    seedSshWorkspaceSettings({ hosts: true })
    await browser.reloadSession()
  })

  after(() => {
    host.remove()
    resetUserData()
  })

  // One test, because the second visit depends on the project the first adds;
  // CI's burn-in also runs every test on its own.
  it("opens in the account's home, then beside the last project from that host", async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    const dialog = await openRemoteFolderDialog()

    assert.deepEqual(await listing('dev'), ['notes', 'projects'])
    assert.match(await dialog.$('.remote-folder-breadcrumbs').getText(), /copse-e2e-browse-start/)
    // The root stays one click away.
    await expect(dialog.$('.remote-folder-up')).toBeEnabled()
    await saveElementScreenshot('#remote-folder-dialog', 'remote-folder-browse-start-home.png')

    await dialog.$('.remote-folder-entry=projects').click()
    assert.deepEqual(await listing('projects'), ['api', 'web'])
    await dialog.$('.remote-folder-entry=api').click()
    await browser.waitUntil(
      async () => (await dialog.$('.remote-folder-crumb-current').getText()) === 'api',
      { timeout: 10_000, timeoutMsg: 'the dialog never entered api' },
    )
    await dialog.$('.remote-folder-open').click()
    await expect(dialog).not.toBeDisplayed()
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.api.sshWorkspace.getStates())).some(
          (state) => state.hostId === 'dev' && state.status === 'connected',
        ),
      { timeout: 15_000, timeoutMsg: 'the remote project never connected' },
    )

    // The next time, the dialog opens beside that project.
    const again = await openRemoteFolderDialog()
    assert.deepEqual(await listing('projects'), ['api', 'web'])
    await saveElementScreenshot('#remote-folder-dialog', 'remote-folder-browse-start-beside.png')
    await again.$('.remote-folder-cancel').click()
    await expect(again).not.toBeDisplayed()
  })
})
