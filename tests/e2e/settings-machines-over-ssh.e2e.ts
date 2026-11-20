import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import type { ClassifierProfile, ClassifierResult } from '@copse/llm/classifiers/index.ts'
import { MachineManager } from '../../src/main/services/machines/machine-manager.ts'
import {
  machineStoreSchema,
  type MachineStore,
  type MachineStoreData,
} from '../../src/main/services/machines/machine-store.ts'
import { createKeyringCipher } from '../../src/main/services/storage/keyring-cipher.ts'
import { installFakeSshHost, type FakeSshHost } from './helpers/fake-ssh.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSettings,
} from './helpers/seed-config.ts'

const PROFILE: ClassifierProfile = {
  id: 'local-kev',
  label: 'Local Kev',
  model: 'kev-fixture',
  timeoutMs: 5000,
  connection: {
    type: 'http',
    protocol: 'systemone',
    auth: 'none',
    baseUrl: 'http://127.0.0.1:1/v1',
  },
}

const RESULT: ClassifierResult = {
  profileId: PROFILE.id,
  adapter: 'systemone',
  requestedModel: PROFILE.model,
  model: PROFILE.model,
  answers: {},
  elapsedMs: 1,
}

/** The model computer, run in this process and sharing on its own loopback only. */
function createModelComputer(): MachineManager {
  let saved: MachineStoreData | null = null
  let key: string | null = null
  const cipher = createKeyringCipher({
    read: () => key,
    write: (next) => {
      key = next
    },
  })
  const store: MachineStore = {
    enabled: () => true,
    load: () => saved,
    save: async (next: MachineStoreData) => {
      saved = machineStoreSchema.parse(structuredClone(next))
      await Promise.resolve()
    },
    routes: () => ({}),
    saveRoutes: async () => {
      await Promise.resolve()
    },
    available: () => true,
    seal: (value: string) => cipher.encryptString(value).toString('base64'),
    open: (value: string) => cipher.decryptString(Buffer.from(value, 'base64')),
  }
  return new MachineManager(
    store,
    () => [PROFILE],
    async () => RESULT,
    'Model computer',
  )
}

describe('Settings → Machines pairs a machine over SSH', function () {
  this.timeout(90_000)
  let sshHost: FakeSshHost
  let modelComputer: MachineManager
  let invitation = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    sshHost = installFakeSshHost()
    modelComputer = createModelComputer()
    // "This computer only": nothing listens beyond loopback.
    await modelComputer.share({
      enabled: true,
      address: '127.0.0.1',
      port: 0,
      profileIds: [PROFILE.id],
    })
    invitation = modelComputer.invitation()
    seedEmptyProject(seedStableWorkspace(), 'e2e-machines-over-ssh')
    writeSettings({
      remoteSystemOneModelsEnabled: true,
      sshWorkspaceEnabled: true,
      sshWorkspaceHosts: [{ id: 'dev', label: 'Dev Server', host: 'dev.example', user: 'ubuntu' }],
    })
    await browser.reloadSession()
  })

  after(async () => {
    await modelComputer.close()
    sshHost.remove()
    resetUserData()
  })

  it('reaches the shared model through the saved SSH host, with no address to choose', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="ssh"]').click()

    const via = $('select[name="machinePairVia"]')
    await via.scrollIntoView({ block: 'center' })
    await browser.waitUntil(
      async () =>
        (
          await browser.execute(() =>
            [...document.querySelectorAll('select[name="machinePairVia"] option')].map((option) =>
              option.textContent.trim(),
            ),
          )
        ).includes('SSH: Dev Server (dev.example)'),
      { timeout: 10_000, timeoutMsg: 'saved SSH machines are not offered as a route' },
    )
    await via.selectByAttribute('value', 'dev')
    // Captured before the invitation is pasted: its secret differs on every run.
    await saveElementScreenshot('.machine-pair-controls', 'settings-machines-pair-over-ssh.png')
    await $('[name="machineInvitation"]').setValue(invitation)

    const state = await browser.execute(async () => window.api.machines.state())
    if (!state.secureStorage) {
      // A headless Linux runner without a keyring must refuse pairing, not use a
      // test-only bypass (as settings-machines.e2e.ts). The forward itself is
      // covered there by machine-service.test.ts against the same stub `ssh`.
      await expect($('.machine-pair')).toBeDisabled()
      return
    }
    const pair = $('.machine-pair')
    await pair.scrollIntoView({ block: 'center' })
    await pair.click()

    // The paired machine joins "Your machines", marked with its route.
    const row = $('.machines-overview .machine-row')
    await row.waitForExist({ timeout: 20_000 })
    await expect(row.$('h4')).toHaveText('Model computer')
    await expect(row.$('.machine-connection-status')).toHaveText(
      expect.stringContaining('over SSH through Dev Server'),
    )
    const chips = await browser.execute(() =>
      [...document.querySelectorAll('.machines-overview .machine-row .machine-use')].map((item) =>
        item.textContent.trim(),
      ),
    )
    assert.deepEqual(chips, ['1 shared model', 'Over SSH through Dev Server'])
    const routes = await browser.execute(() => window.api.settings.get('machineSshRoutes'))
    assert.ok(routes && typeof routes === 'object')
    assert.deepEqual(Object.values(routes), ['dev'])

    // The status check goes through the same forward, without prompting.
    await browser.waitUntil(
      async () => (await row.$('.machine-summary-status').getText()) === 'Connected',
      { timeout: 20_000, timeoutMsg: 'the status check did not reach the machine over SSH' },
    )
    await row.scrollIntoView({ block: 'center' })
    await saveElementScreenshot('.machines-overview', 'settings-machines-over-ssh.png')
  })
})
