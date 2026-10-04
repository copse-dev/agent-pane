import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  readSeededSettings,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'

const CODER = 'qwen/qwen3.6-35b-a3b'
const SAFETY = 'qwen/qwen3-4b-2507'
const DOCS = 'google/gemma-3-12b'
const RESEARCH = 'mistralai/mistral-small-24b'
const STALE = 'removed-provider:model'

describe('persisted model recovery through main-process IPC', function () {
  this.timeout(120_000)
  let url = ''
  let models = [CODER, SAFETY, DOCS, RESEARCH]
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: models.map((id) => ({ id })) }))
    } else if (request.url === '/api/v1/models') {
      response.end(JSON.stringify({ models: models.map((key) => ({ key, type: 'llm' })) }))
    } else {
      response.writeHead(404)
      response.end()
    }
  })

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    url = await new Promise<string>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') return reject(new Error('No fixture address'))
        resolve(`http://127.0.0.1:${address.port}/v1`)
      })
    })
    writeE2eEnv({ COPSE_PANEL_MOCK_LLM: '0', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' })
  })

  after(async () => {
    writeE2eEnv({ COPSE_PANEL_MOCK_LLM: '1' })
    resetUserData()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  })

  async function seed(roleModels: Record<string, string>, safetyModel = ''): Promise<void> {
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-provider-model-recovery', {
      model: `lmstudio:${CODER}`,
      localServerUrl: url,
      safetyModel,
      reviewModel: STALE,
      roleModels,
      subagentsEnabled: false,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('#confirm-dialog').waitForDisplayed({ timeout: 30_000 })
  }

  it('repairs guarded model fields and individual roles with verified local capability, preserving other choices', async () => {
    models = [CODER, SAFETY, DOCS, RESEARCH]
    await seed({ docs: STALE, research: 'claude-haiku-4-5', planner: `lmstudio:${CODER}` }, STALE)
    await expect($('.confirm-dialog-detail')).toHaveText(
      expect.stringContaining('Instruct / safety model'),
    )
    await expect($('.confirm-dialog-detail')).toHaveText(expect.stringContaining('Research'))
    await saveElementScreenshot('#confirm-dialog', 'provider-model-role-warning.png')
    await $('.confirm-dialog-cancel').click()
    await browser.waitUntil(
      () => {
        const values = readSeededSettings()
        const roles = values['roleModels']
        return (
          values['safetyModel'] === `lmstudio:${SAFETY}` &&
          values['reviewModel'] === `lmstudio:${CODER}` &&
          typeof roles === 'object' &&
          roles !== null &&
          Object.hasOwn(roles, 'docs') &&
          Reflect.get(roles, 'docs') === `lmstudio:${DOCS}` &&
          Reflect.get(roles, 'research') === `lmstudio:${RESEARCH}`
        )
      },
      { timeout: 30_000, timeoutMsg: 'main did not persist role-capable recovery' },
    )
    const settings = readSeededSettings()
    assert.equal(settings['model'], `lmstudio:${CODER}`)
    assert.equal(settings['safetyClassifierEnabled'], undefined)
    assert.equal(settings['autoRunSandboxCommands'], undefined)
    const roles = settings['roleModels']
    assert.ok(typeof roles === 'object' && roles !== null)
    assert.equal(Reflect.get(roles, 'planner'), `lmstudio:${CODER}`)
  })

  it('opens the exact additional-role field and saves only edited assignments', async () => {
    models = [CODER]
    // Chat and review remain valid. Only Docs needs attention and has no suitable fallback.
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-provider-model-recovery', {
      model: `lmstudio:${CODER}`,
      localServerUrl: url,
      reviewModel: `lmstudio:${CODER}`,
      roleModels: { docs: STALE, planner: `lmstudio:${CODER}` },
    })
    await browser.reloadSession()
    await $('#confirm-dialog').waitForDisplayed({ timeout: 30_000 })
    await expect($('.confirm-dialog-detail')).toHaveText(
      expect.stringContaining('No suitable on-device model'),
    )
    await $('.confirm-dialog-confirm').click()
    await $('#settings-dialog').waitForDisplayed()
    await browser.waitUntil(
      async () =>
        (await browser.execute(() =>
          document.activeElement?.getAttribute('data-model-setting-target'),
        )) === 'role:docs',
      { timeout: 30_000, timeoutMsg: 'Docs picker was not revealed and focused' },
    )
    await expect($('.routing-additional-roles')).toHaveAttribute('open')
    await saveElementScreenshot('#settings-dialog', 'provider-model-exact-role-settings.png')
    const picker = $('[data-model-picker-for="role:docs"]')
    await picker.$('.model-picker-trigger').click()
    await picker.$('.model-picker-option[data-value=""]').click()
    await $('#settings-dialog button[type="submit"]').click()
    await browser.waitUntil(
      () => {
        const roles = readSeededSettings()['roleModels']
        return typeof roles === 'object' && roles !== null && Reflect.get(roles, 'docs') === ''
      },
      { timeout: 30_000, timeoutMsg: 'edited Docs assignment was not saved' },
    )
    const roles = readSeededSettings()['roleModels']
    assert.ok(typeof roles === 'object' && roles !== null)
    assert.equal(Reflect.get(roles, 'planner'), `lmstudio:${CODER}`)
  })

  it('preserves the saved choice if the proposed local model disappears before dismissal', async () => {
    models = [CODER, SAFETY, DOCS, RESEARCH]
    await seed({ docs: STALE })
    await expect($('.confirm-dialog-detail')).toHaveText(expect.stringContaining(DOCS))
    models = [CODER]
    await $('.confirm-dialog-cancel').click()
    // Await the native recovery call by opening Settings, which queues its settings reads afterwards.
    await $('[aria-label="Settings"]').click()
    await $('select[name="role:docs"] option[value="removed-provider:model"]').waitForExist({
      timeout: 30_000,
    })
    const roles = readSeededSettings()['roleModels']
    assert.ok(typeof roles === 'object' && roles !== null)
    assert.equal(Reflect.get(roles, 'docs'), STALE)
  })
})
