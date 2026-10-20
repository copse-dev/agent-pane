import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import {
  readSeededSettings,
  resetUserData,
  seedEmptyProject,
  writeSettings,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

const FIXTURE_PORT = 51247
const GOOD_KEY = 'sk-or-v1-e2e-accepted-key' // gitleaks:allow -- inert local HTTP fixture
const BAD_KEY = 'sk-or-v1-e2e-rejected-key'

// Models & agents → + Add → API key: one paste box. Copse works out the
// provider from the key's prefix (asking when it cannot), checks the key with
// that provider, asks before storing it unencrypted, and lists it as a row with
// Options and Remove. OpenRouter's auth probe is served by a local fixture via
// the existing `openRouterApiBase` endpoint setting; OS secret storage is made
// unavailable at the e2e shell's cipher boundary, with the plaintext opt-in on,
// so the per-save consent prompt is deterministic on every host.
describe('Add an API key from Models & agents', () => {
  let server: Server | null = null
  const validated: string[] = []

  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    server = createServer((request, response) => {
      if ((request.url ?? '').endsWith('/key')) {
        const auth = request.headers.authorization ?? ''
        validated.push(auth)
        const ok = auth === `Bearer ${GOOD_KEY}`
        response.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
        response.end(JSON.stringify(ok ? { data: { label: 'e2e' } } : { error: 'bad key' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [] }))
    })
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject)
      server?.listen(FIXTURE_PORT, '127.0.0.1', resolve)
    })
    writeE2eEnv({ COPSE_E2E_SECRET_STORAGE: 'unavailable', COPSE_ALLOW_PLAINTEXT_SECRETS: '1' })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-paste-key', {
      windowBounds: { width: 1280, height: 800 },
    })
    writeSettings({
      ...readSeededSettings(),
      openRouterApiBase: `http://127.0.0.1:${String(FIXTURE_PORT)}/api/v1`,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(async () => {
    writeE2eEnv({ COPSE_E2E_SECRET_STORAGE: undefined, COPSE_ALLOW_PLAINTEXT_SECRETS: undefined })
    resetUserData()
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  })

  it('detects, rejects, asks for consent, saves, then removes a key', async function () {
    this.timeout(90_000)
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 10_000 })
    await $('.settings-nav-btn[data-section="general"]').click()
    const list = $('[data-testid="models-agents-fieldset"]')
    await list.$('[data-row="plan:chatgpt"]').waitForExist({ timeout: 15_000 })
    await expect(list.$('[data-row="key:openrouter"]')).not.toExist()

    await list.$('[data-testid="connections-add-toggle"]').click()
    await list.$('.acp-add-row[data-add="key"]').$('button=Add key').click()
    const form = list.$('[data-testid="paste-key-form"]')
    await form.waitForDisplayed({ timeout: 15_000 })
    const input = form.$('[data-testid="paste-key-input"]')
    const hint = form.$('[data-testid="paste-key-hint"]')
    const ask = form.$('[data-testid="paste-key-ask"]')
    const save = form.$('[data-testid="paste-key-save"]')
    await expect(save).toBeDisabled()

    // An unknown key asks for its provider and is never sent anywhere first.
    await input.setValue('Zq81mXk93LpTt20abCdEf')
    await expect(hint).toHaveText('doesn’t recognise this key', { containing: true })
    await expect(ask).toBeDisplayed()

    // A recognised prefix names its provider; the provider rejecting it is an error.
    await input.setValue(BAD_KEY)
    await expect(hint).toHaveText('Looks like an OpenRouter key.', { containing: true })
    await expect(ask).not.toBeDisplayed()
    await save.click()
    await expect(hint).toHaveText('Key rejected by OpenRouter', { containing: true })
    assert.deepEqual(validated, [`Bearer ${BAD_KEY}`])
    await expect(list.$('[data-row="key:openrouter"]')).not.toExist()

    const overflow = await browser.execute(() => {
      const host = document.querySelector('[data-testid="paste-key-form"]')
      return host ? host.scrollWidth - host.clientWidth : -1
    })
    assert.ok(overflow <= 0, 'paste-key form must not overflow sideways')
    await form.scrollIntoView({ block: 'center' })
    await browser.pause(200)
    await saveElementScreenshot('[data-testid="connections-add-menu"]', 'settings-paste-key.png')

    // An accepted key still needs consent before it is stored unencrypted.
    await input.setValue(GOOD_KEY)
    await save.click()
    const consent = $('#confirm-dialog')
    await consent.waitForDisplayed({ timeout: 15_000 })
    await expect(consent.$('.confirm-dialog-message')).toHaveText(
      'No OS keyring is available to encrypt your OpenRouter key at rest',
      { containing: true },
    )
    await consent.$('.confirm-dialog-confirm').click()
    await expect(hint).toHaveText('OpenRouter key saved.', { containing: true })

    const row = list.$('[data-row="key:openrouter"]')
    await row.waitForExist({ timeout: 15_000 })
    await expect(row.$('.acp-row-chip')).toHaveText('Saved')
    await expect(row.$('.acp-row-desc')).toHaveText('stored unencrypted on this machine', {
      containing: true,
    })
    // The secret is never shown back.
    assert.doesNotMatch(await list.getText(), /e2e-accepted-key/)

    // Options opens the provider's own settings: key test and privacy routing.
    await list.$('[data-testid="connections-add-toggle"]').click()
    await row.$('button=Options').click()
    await expect(row.$('[data-provider-key-status="openrouter"]')).toHaveText('saved')
    await expect(row.$('label*=zero-data-retention')).toExist()
    await row.scrollIntoView({ block: 'start' })
    await browser.pause(200)
    await saveElementScreenshot(
      '[data-testid="models-agents-fieldset"]',
      'settings-models-agents-key-row.png',
    )

    // Remove asks first, then clears only the stored key.
    await row.$('button=Remove').click()
    await consent.waitForDisplayed({ timeout: 10_000 })
    await expect(consent.$('.confirm-dialog-message')).toHaveText(
      'Remove the OpenRouter API key from Copse?',
    )
    await consent.$('.confirm-dialog-confirm').click()
    await list.$('[data-row="key:openrouter"]').waitForExist({ reverse: true, timeout: 15_000 })
    assert.equal(await browser.execute(() => window.api.settings.getKey('openrouter')), false)
  })
})
