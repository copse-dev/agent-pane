import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  installFakeSshHost,
  useLocalSshConfig,
  type FakeSshHost,
  type LocalSshConfig,
} from './helpers/fake-ssh.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedEmptyProject,
  seedSshWorkspaceSettings,
  seedStableWorkspace,
} from './helpers/seed-config.ts'

// A fixed path, because the breadcrumbs show it in the screenshot.
const REMOTE_HOME = join(tmpdir(), 'copse-e2e-ssh-config-hosts', 'studio')

const SSH_CONFIG = [
  'Host studio',
  '  HostName studio.internal',
  '  User dev',
  '',
  'Host build-box',
  '  HostName 10.0.0.12',
  '',
  'Host *',
  '  ServerAliveInterval 60',
  '',
].join('\n')

/** Option labels inside the picker's `~/.ssh/config` group, in order. */
function configGroupOptions(): Promise<string[]> {
  return browser.execute(() =>
    [
      ...document.querySelectorAll(
        '#remote-folder-dialog .remote-folder-host optgroup[label="In ~/.ssh/config"] option',
      ),
    ].map((option) => option.textContent.trim()),
  )
}

describe('Open remote folder — hosts from ~/.ssh/config', () => {
  let host: FakeSshHost
  let sshConfig: LocalSshConfig

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    sshConfig = useLocalSshConfig(SSH_CONFIG)
    host = installFakeSshHost({ remoteHome: REMOTE_HOME })
    mkdirSync(join(REMOTE_HOME, 'projects'), { recursive: true })
    seedEmptyProject(seedStableWorkspace(), 'e2e-remote-folder-ssh-config-hosts')
    seedSshWorkspaceSettings({ hosts: false })
    await browser.reloadSession()
  })

  after(() => {
    host.remove()
    sshConfig.remove()
    resetUserData()
  })

  it('offers config hosts in the picker and saves only the one chosen', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('.projects-add-btn').click()
    await $('.context-menu-item*=Open remote project').click()
    const dialog = await $('#remote-folder-dialog').getElement()
    await expect(dialog).toBeDisplayed()

    const select = dialog.$('.remote-folder-host')
    await browser.waitUntil(async () => (await configGroupOptions()).length > 0, {
      timeout: 10_000,
      timeoutMsg: 'the picker never offered the ~/.ssh/config hosts',
    })
    // The wildcard stanza is not a host anyone can pick.
    assert.deepEqual(await configGroupOptions(), ['studio', 'build-box'])
    await expect(select).toBeEnabled()
    await expect(select).toHaveValue('')
    assert.match(
      await dialog.$('.remote-folder-add-host-hint').getText(),
      /Choose one from ~\/\.ssh\/config above/,
    )
    await saveElementScreenshot('#remote-folder-dialog', 'remote-folder-ssh-config-hosts.png')

    await select.selectByAttribute('value', 'ssh-config:studio')
    const current = dialog.$('.remote-folder-crumb-current')
    await browser.waitUntil(async () => (await current.getText()) === 'studio', {
      timeout: 15_000,
      timeoutMsg: 'choosing a config host did not open its home directory',
    })
    // Saved alone, as the alias only, so OpenSSH applies the whole stanza.
    const saved = await browser.execute(() => window.api.settings.get('sshWorkspaceHosts'))
    assert.deepEqual(saved, [{ id: 'studio', label: 'studio', host: 'studio' }])
    assert.deepEqual(await configGroupOptions(), ['build-box'], 'a saved host is not offered twice')

    await dialog.$('.remote-folder-cancel').click()
    await expect(dialog).not.toBeDisplayed()
  })
})
