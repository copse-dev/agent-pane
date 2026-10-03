import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { $, browser, expect } from '@wdio/globals'
import {
  classify,
  CLASSIFIER_TEST_REQUEST,
  type ClassifierProfile,
} from '@copse/llm/classifiers/index.ts'
import { MachineManager } from '../../src/main/services/machines/machine-manager.ts'
import {
  machineStoreSchema,
  type MachineStoreData,
} from '../../src/main/services/machines/machine-store.ts'
import { createKeyringCipher } from '../../src/main/services/storage/keyring-cipher.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

/** Actual Electron IPC + OS credentials + a separate production TLS host with fixture inference. */
describe('Machines settings', function () {
  this.timeout(120_000)
  let native: Server | undefined
  let host: MachineManager | undefined
  let invitation = ''
  let calls = 0
  let baseUrl = ''
  let profile: ClassifierProfile
  let saved: MachineStoreData | null = null
  let key: string | null = null
  const cipher = createKeyringCipher({
    read: () => key,
    write: (next) => {
      key = next
    },
  })
  const store = {
    enabled: () => true,
    load: () => saved,
    save: async (next: MachineStoreData) => {
      saved = machineStoreSchema.parse(structuredClone(next))
    },
    available: () => true,
    seal: (value: string) => cipher.encryptString(value).toString('base64'),
    open: (value: string) => cipher.decryptString(Buffer.from(value, 'base64')),
  }
  function createHost(): MachineManager {
    return new MachineManager(
      store,
      () => [profile],
      async (_id, request, signal) => classify(profile, request, { signal }),
      'Model computer',
    )
  }
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ TYPESAFE_API_KEY: '', FEATHERLESS_API_KEY: '' })
    native = createServer((request, response) => {
      assert.equal(request.url, '/v1/systemone')
      request.resume()
      calls++
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          model: 'kev-fixture',
          answers: {
            color: {
              type: 'choice',
              choice: 'red',
              probabilities: { red: 0.9, blue: 0.1 },
              confidence: 0.7,
            },
          },
        }),
      )
    })
    await new Promise<void>((resolve) => native?.listen(0, '127.0.0.1', resolve))
    const address = native.address()
    assert.ok(address && typeof address !== 'string')
    baseUrl = `http://127.0.0.1:${String(address.port)}/v1`
    profile = {
      id: 'local-kev',
      label: 'Local Kev',
      model: 'kev-fixture',
      timeoutMs: 5000,
      connection: { type: 'http', protocol: 'systemone', auth: 'none', baseUrl },
    }
    host = createHost()
    await host.share({ enabled: true, address: '127.0.0.1', port: 0, profileIds: [profile.id] })
    invitation = host.invitation()
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-machines')
    await browser.reloadSession()
  })
  after(async () => {
    await host?.close()
    await new Promise<void>((resolve) => {
      if (native) native.close(() => resolve())
      else resolve()
    })
    writeE2eEnv({
      TYPESAFE_API_KEY: undefined,
      FEATHERLESS_API_KEY: undefined,
      COPSE_E2E_SECRET_STORAGE: undefined,
    })
    resetUserData()
  })
  async function openMachines(): Promise<void> {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    const nav = $('#settings-dialog button[data-section="ssh"]')
    await expect(nav).toHaveText(expect.stringContaining('Machines'))
    await nav.click()
    await $('.machines-settings').waitForDisplayed()
  }
  async function click(selector: string): Promise<void> {
    const button = $(selector)
    await button.scrollIntoView({ block: 'center' })
    await button.click()
  }
  async function setExperiment(enabled: boolean, capture = false): Promise<void> {
    await $('#settings-dialog button[data-section="experimental"]').click()
    const toggle = $('[name="remoteSystemOneModelsEnabled"]')
    await toggle.scrollIntoView({ block: 'center' })
    if ((await toggle.isSelected()) !== enabled) await toggle.click()
    if (capture)
      await saveElementScreenshot(
        'fieldset:has([name="remoteSystemOneModelsEnabled"])',
        'settings-machines-experimental.png',
      )
    await click('#settings-dialog button[type="submit"]')
    await $('#settings-dialog').waitForDisplayed({ reverse: true })
    await openMachines()
    const state = await browser.execute(async () => window.api.machines.state())
    assert.equal(state.featureEnabled, enabled)
  }
  it('gates pairing and routing while preserving SSH, reconnection and cleanup', async function () {
    await openMachines()
    await expect($('#settings-ssh-workspace-host legend')).toHaveText('SSH workspaces')
    const state = await browser.execute(async () => window.api.machines.state())
    assert.equal(state.featureEnabled, false, 'the experiment defaults off')
    await expect($('.machine-pair-controls')).not.toBeDisplayed()
    await expect($('.machine-sharing-controls')).not.toBeDisplayed()
    await expect($('.machine-feature-hint')).toHaveText(expect.stringContaining('Experimental'))
    await assert.rejects(
      browser.execute(async () => window.api.machines.pair('invalid')),
      /Enable Remote System One/,
    )
    await assert.rejects(
      browser.execute(async () => window.api.machines.invitation()),
      /Enable Remote System One/,
    )
    await assert.rejects(
      browser.execute(async () =>
        window.api.machines.share({
          enabled: true,
          address: '127.0.0.1',
          port: 0,
          profileIds: ['local-kev'],
        }),
      ),
      /Enable Remote System One/,
    )
    await saveElementScreenshot('#settings-dialog', 'settings-machines-disabled.png')
    await setExperiment(true, true)
    if (!state.secureStorage) {
      // A headless Linux runner without a keyring must refuse pairing, not use a test-only bypass.
      await expect($('.machine-pair')).toBeDisabled()
      await expect($('.machine-secure-storage')).toHaveText(expect.stringContaining('Unlock'))
      await saveElementScreenshot('#settings-dialog', 'settings-machines-locked.png')
      return
    }
    await $('[name="machineInvitation"]').setValue('invalid')
    await click('.machine-pair')
    await expect($('.machine-status')).toHaveText(expect.stringContaining('Paste the invitation'))
    await $('[name="machineInvitation"]').setValue(invitation)
    await click('.machine-pair')
    await expect($('.machine-row h4')).toHaveText('Model computer')
    await expect($('.machine-connection-status')).toHaveText(expect.stringContaining('Connected'))
    assert.equal(calls, 0, 'pairing and discovery never invoke inference')
    await browser.execute(() => {
      const content = document.querySelector('#settings-dialog .settings-content')
      if (content) content.scrollTop = 0
    })
    await saveElementScreenshot('#settings-dialog', 'settings-machines-connected.png')
    await click('.machine-use-model')
    await expect($('.machine-status')).toHaveText(expect.stringContaining('Model connection saved'))
    const configured = await browser.execute(async () => window.api.classifiers.list())
    const remote = configured[0]?.profile
    assert.equal(configured.length, 1)
    assert.ok(remote && remote.connection.type === 'machine')
    assert.equal(calls, 0)
    await $('#settings-dialog button[data-section="classifiers"]').click()
    await expect($('[name="classifierModel"]')).toHaveAttribute('readonly')
    await click('.classifier-test')
    await expect($('.classifier-status')).toHaveText(expect.stringContaining('Test succeeded'))
    assert.equal(calls, 1)
    await saveElementScreenshot('#settings-dialog', 'settings-machines-classifier.png')
    const result = await browser.execute(async (id) => window.api.classifiers.test(id), remote.id)
    assert.deepEqual(result.answers['color'], {
      type: 'choice',
      choice: 'red',
      probabilities: { red: 0.9, blue: 0.1 },
      confidence: 0.7,
    })
    assert.equal(calls, 2)
    await assert.rejects(
      browser.execute(async () => window.api.settings.get('machineConnections')),
      /not readable/,
    )
    await setExperiment(false)
    await expect($('.machine-remove')).toBeEnabled()
    await expect($('.machine-use-model')).not.toBeDisplayed()
    await assert.rejects(
      browser.execute(async (id) => window.api.classifiers.test(id), remote.id),
      /Enable Remote System One/,
    )
    await browser.reloadSession()
    await openMachines()
    assert.equal(
      (await browser.execute(async () => window.api.machines.state())).featureEnabled,
      false,
    )
    await expect($('.machine-row h4')).toHaveText('Model computer')
    await saveElementScreenshot('#settings-dialog', 'settings-machines-paused.png')
    assert.equal(calls, 2)
    await setExperiment(true)
    await host?.close()
    await $('#settings-dialog button[data-section="classifiers"]').click()
    await $('#settings-dialog button[data-section="ssh"]').click()
    await expect($('.machine-connection-status')).toHaveText(
      expect.stringContaining('reconnect automatically'),
    )
    await browser.execute(() => {
      const content = document.querySelector('#settings-dialog .settings-content')
      if (content) content.scrollTop = 0
    })
    await saveElementScreenshot('#settings-dialog', 'settings-machines-offline.png')
    assert.equal(calls, 2, 'disconnection never replays a model call')
    host = createHost()
    await host.restore()
    await browser.reloadSession()
    await openMachines()
    await expect($('.machine-connection-status')).toHaveText(expect.stringContaining('Connected'))
    assert.equal(calls, 2)
    await $('#settings-dialog button[data-section="classifiers"]').click()
    await click('.classifier-test')
    await expect($('.classifier-status')).toHaveText(expect.stringContaining('Test succeeded'))
    assert.equal(calls, 3)
    const client = host.snapshot().clients[0]
    assert.ok(client)
    await host.revoke(client.id)
    await $('#settings-dialog button[data-section="ssh"]').click()
    await expect($('.machine-connection-status')).toHaveText(expect.stringContaining('revoked'))
    await expect($('.machine-use-model')).toBeDisabled()
    await click('.machine-remove')
    await expect($('.machine-row')).not.toExist()

    // Exercise the real app as the sharing host too, through its existing classifier surface.
    await browser.execute(async (local) => window.api.classifiers.save(local), {
      ...profile,
      id: 'desktop-kev',
    })
    await $('#settings-dialog button[data-section="classifiers"]').click()
    await $('#settings-dialog button[data-section="ssh"]').click()
    await $('[name="machineSharedProfile"][value="desktop-kev"]').waitForExist()
    await click('[name="machineSharedProfile"][value="desktop-kev"]')
    await click('[name="machineSharingEnabled"]')
    await $('[name="machineSharingAddress"]').selectByAttribute('value', '127.0.0.1')
    await $('[name="machineSharingPort"]').setValue('0')
    await click('.machine-sharing-save')
    await expect($('.machine-sharing-status')).toHaveText(
      expect.stringContaining('Sharing on 127.0.0.1'),
    )
    await click('.machine-invite')
    const appInvitation = await $('[name="machineSharingInvitation"]').getValue()
    const appMachine = (await host.pair(appInvitation)).machines[0]
    assert.ok(appMachine)
    await host.call(
      appMachine.id,
      'desktop-kev',
      CLASSIFIER_TEST_REQUEST,
      new AbortController().signal,
      5000,
    )
    assert.equal(calls, 4)
    await setExperiment(false)
    const stopped = await browser.execute(async () => window.api.machines.state())
    assert.equal(stopped.sharing.listening, false)
    assert.equal(stopped.clients.length, 1)
    await assert.rejects(
      host.call(
        appMachine.id,
        'desktop-kev',
        CLASSIFIER_TEST_REQUEST,
        new AbortController().signal,
        5000,
      ),
    )
    await browser.reloadSession()
    await openMachines()
    assert.equal(
      (await browser.execute(async () => window.api.machines.state())).sharing.listening,
      false,
    )
    await expect($('.machine-revoke')).toBeEnabled()
    await setExperiment(true)
    await host.call(
      appMachine.id,
      'desktop-kev',
      CLASSIFIER_TEST_REQUEST,
      new AbortController().signal,
      5000,
    )
    assert.equal(calls, 5, 're-enabling restores sharing with the same credentials')
    await setExperiment(false)
    await $('.machine-revoke').waitForExist()
    await click('.machine-revoke')
    await expect($('.machine-client-row')).not.toExist()
    await assert.rejects(
      host.call(
        appMachine.id,
        'desktop-kev',
        CLASSIFIER_TEST_REQUEST,
        new AbortController().signal,
        5000,
      ),
    )
    await setExperiment(true)
    await saveElementScreenshot('.machine-sharing-section', 'settings-machines-sharing.png')
    await click('[name="machineSharingEnabled"]')
    await click('.machine-sharing-save')
    await expect($('.machine-sharing-status')).toHaveText('Model sharing is off.')
    assert.equal(calls, 5)
  })
  it('refuses new connections when encrypted storage is unavailable', async () => {
    writeE2eEnv({ COPSE_E2E_SECRET_STORAGE: 'unavailable' })
    await browser.reloadSession()
    await openMachines()
    await expect($('.machine-pair')).toBeDisabled()
    await expect($('.machine-secure-storage')).toHaveText(expect.stringContaining('Unlock'))
    await assert.rejects(
      browser.execute(async () => window.api.machines.pair('invalid')),
      /Unlock secure storage/,
    )
    await click('[name="machineSharingEnabled"]')
    await expect($('.machine-sharing-save')).toBeDisabled()
    await browser.execute(() => {
      const content = document.querySelector('#settings-dialog .settings-content')
      if (content) content.scrollTop = 0
    })
    await saveElementScreenshot('#settings-dialog', 'settings-machines-locked.png')
  })
})
