import { createServer, type Server } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { readSeededSettings, resetUserData, seedOnboardingFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, prepareE2eScreenshot } from './helpers/screenshot.ts'

// The happy path with real detections, made deterministic by injecting them:
// two provider keys through the electron-shell env file (bootstrap.cjs applies
// it before main runs), a fixture "Jan" server on its preset port 1337, and a
// fixture LM Studio server whose ephemeral port is seeded as localServerUrl.
// The spec then proves the checklist honours unticking and that finish
// persists imports + relative-selector defaults to settings.json on disk.

function modelServer(modelId: string): Server {
  return createServer((req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: modelId }] }))
      return
    }
    res.statusCode = 404
    res.end()
  })
}

function listen(server: Server, port: number, what: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `port ${String(port)} is busy — is ${what} actually running on this machine? ` +
                'Stop it (or skip this spec) and retry.',
            )
          : err,
      )
    })
    server.listen(port, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

describe('onboarding: scan finds keys and local servers', () => {
  const janServer = modelServer('e2e-jan-model')
  const lmServer = modelServer('e2e-lm-model')

  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    // Jan's preset probe URL is fixed (http://127.0.0.1:1337/v1), so the fixture
    // must own the real port; LM Studio's probe honours localServerUrl, so its
    // fixture takes any free port.
    await listen(janServer, 1337, 'Jan (or something else on its port)')
    const lmPort = await listen(lmServer, 0, 'unused')
    writeE2eEnv({
      ANTHROPIC_API_KEY: 'sk-ant-e2e-scan-import-0001',
      OPENAI_API_KEY: 'sk-oai-e2e-scan-import-0001',
    })
    seedOnboardingFixture({ localServerUrl: `http://127.0.0.1:${String(lmPort)}/v1` })
    await browser.reloadSession()
  })

  after(async () => {
    // Restore the blanked-key base env for later specs in this worker.
    writeE2eEnv({})
    await new Promise((resolve) => janServer.close(resolve))
    await new Promise((resolve) => lmServer.close(resolve))
    resetUserData()
  })

  it('pre-checks every detection and shows LM Studio as automatic', async function () {
    this.timeout(120_000)
    const overlay = await $('#onboarding-dialog')
    await overlay.waitForDisplayed({ timeout: 30_000 })

    const row = (kind: string, id: string): string =>
      `.detected-item-row[data-kind="${kind}"][data-id="${id}"]`
    await overlay.$(row('env-key', 'anthropic')).waitForDisplayed({ timeout: 30_000 })

    for (const id of ['anthropic', 'openai']) {
      const box = overlay.$(`${row('env-key', id)} input.detected-item-check`)
      await box.waitForExist({ timeout: 10_000 })
      expect(await box.isSelected()).toBe(true)
    }
    const janBox = overlay.$(`${row('local-server', 'jan')} input.detected-item-check`)
    await janBox.waitForExist({ timeout: 10_000 })
    expect(await janBox.isSelected()).toBe(true)

    // LM Studio needs no import — its row is informational.
    const lmRow = overlay.$(row('local-server', 'lmstudio'))
    await lmRow.waitForExist({ timeout: 10_000 })
    expect(await lmRow.getText()).toContain('used automatically')
    expect(await lmRow.$$('input').length).toBe(0)

    await prepareE2eScreenshot()
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'onboarding-scan-results.png'))
  })

  it('finish imports what stayed ticked and writes relative-selector defaults', async function () {
    this.timeout(120_000)
    const overlay = await $('#onboarding-dialog')

    // Untick OpenAI: its key must stay out of Copse storage.
    await overlay
      .$('.detected-item-row[data-kind="env-key"][data-id="openai"] input.detected-item-check')
      .click()
    await overlay.$('#onboarding-finish').click()
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.querySelector<HTMLDialogElement>('#onboarding-dialog')?.open === false,
        ),
      { timeout: 30_000, timeoutMsg: 'onboarding did not close after finish' },
    )

    const settings = readSeededSettings()
    expect(settings['onboardingCompleted']).toBe(true)
    expect(settings['envKeyAutoDetectEnabled']).toBe(true)

    const apiKeys = (settings['apiKey'] ?? {}) as Record<string, unknown>
    expect(apiKeys['anthropic'] ?? settings['apiKey.anthropic']).toBeDefined()
    expect(apiKeys['openai'] ?? settings['apiKey.openai']).toBeUndefined()

    // The Jan fixture's model was imported into the extra-provider store.
    expect(JSON.stringify(settings['extraProviders'] ?? '')).toContain('e2e-jan-model')

    // Defaults are relative selectors — never fixed model ids.
    expect(settings['model']).toBe('auto:balanced')
    expect(settings['localDefaultModel']).toBe('auto:best-local')
    expect(settings['smallTasksModel']).toBe('auto:best-local')
    expect(settings['subagentModel']).toBe('auto:best-local')
    expect(settings['localSubagentsEnabled']).toBe(true)
    expect(settings['localTodoItemsEnabled']).toBe(true)
  })
})
