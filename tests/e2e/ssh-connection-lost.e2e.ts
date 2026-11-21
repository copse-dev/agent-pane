import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { installFakeSshHost, type FakeSshHost } from './helpers/fake-ssh.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedSshWorkspaceSettings } from './helpers/seed-config.ts'

const HOST_ID = 'dev'

async function connectionStatus(): Promise<string | undefined> {
  const states = await browser.execute(() => window.api.sshWorkspace.getStates())
  return states.find((state) => state.hostId === HOST_ID)?.status
}

/**
 * Wait for the restored SSH project to connect. Each test starts here, so it
 * passes when run on its own (CI's burn-in runs every test in isolation).
 */
async function waitUntilConnected(): Promise<void> {
  await $('.prompt-input').waitForExist({ timeout: 15_000 })
  await browser.waitUntil(async () => (await connectionStatus()) === 'connected', {
    timeout: 15_000,
    timeoutMsg: 'the restored SSH project never connected',
  })
  // The banner shows while the project connects. Wait for it to leave, so a
  // later lookup cannot catch the outgoing banner.
  await $('#ssh-status-banner').waitForExist({ reverse: true, timeout: 10_000 })
}

describe('SSH connection status follows the link', () => {
  let host: FakeSshHost

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    host = installFakeSshHost()
    seedEmptyProject(host.remoteRoot, 'e2e-ssh-connection-lost', { sshHost: HOST_ID })
    seedSshWorkspaceSettings({ hosts: true })
    await browser.reloadSession()
  })

  after(() => {
    host.remove()
    resetUserData()
  })

  it('shows no banner for a healthy, watched host', async () => {
    await waitUntilConnected()
    // Open files on the host are watched, so there is nothing to warn about:
    // the old unconditional "remote file watching is not yet supported" line is
    // gone.
    assert.equal(await $('#ssh-status-banner').isExisting(), false)
  })

  it('says the connection was lost when the link drops, and reconnects on request', async () => {
    await waitUntilConnected()
    host.takeDown()
    // A real action, not a test hook: a command that fails at the connection is
    // what tells the app to check the link without waiting for its timer.
    await browser.execute(
      (hostId: string, root: string) =>
        window.api.sshWorkspace.listDirectory(hostId, root).catch(() => undefined),
      HOST_ID,
      host.remoteRoot,
    )

    const banner = await $('#ssh-status-banner').getElement()
    await banner.waitForExist({ timeout: 15_000 })
    await expect(banner).toBeDisplayed()
    const text = await banner.$('.ssh-status-text').getText()
    assert.equal(
      text,
      'SSH connection to ubuntu@dev.example was lost. It reconnects on your next command.',
    )
    assert.equal(await connectionStatus(), 'disconnected')
    const reconnect = await banner.$('button=Reconnect').getElement()
    await expect(reconnect).toBeDisplayed()
    await saveElementScreenshot('#ssh-status-banner', 'ssh-status-banner-connection-lost.png')

    host.bringUp()
    await reconnect.click()
    await browser.waitUntil(async () => (await connectionStatus()) === 'connected', {
      timeout: 15_000,
      timeoutMsg: 'Reconnect did not restore the connection',
    })
    // Before this change a healthy host still carried the watching warning, so
    // the banner never left after a reconnect.
    await $('#ssh-status-banner').waitForExist({ reverse: true, timeout: 10_000 })
  })
})
