import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedOpenRouterFixture } from './helpers/seed-config.ts'

const FIXTURE_PORT = 51243

describe('testing a configured provider key', () => {
  let server: Server | null = null
  let keyRequests = 0
  let lastAuthorization = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.OPENROUTER_API_KEY = ''

    server = createServer((request, response) => {
      const url = request.url ?? ''
      if (url.endsWith('/key')) {
        keyRequests += 1
        lastAuthorization = request.headers.authorization ?? ''
        // Keep the pending state observable before proving the final result.
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ data: { label: 'saved-e2e-key' } }))
        }, 500)
        return
      }
      if (url.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [] }))
        return
      }
      response.writeHead(404)
      response.end()
    })
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject)
      server?.listen(FIXTURE_PORT, '127.0.0.1', resolve)
    })

    resetUserData()
    seedOpenRouterFixture(process.cwd(), {
      apiBase: `http://127.0.0.1:${String(FIXTURE_PORT)}/api/v1`,
    })
    await browser.reloadSession()
  })

  after(async () => {
    resetUserData()
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve()
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('validates the stored key without exposing it in the write-only field', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()

    const providers = $('#settings-providers-host fieldset')
    await expect(providers).toBeDisplayed()
    await providers.$('button=OpenRouter').click()

    const keyGroup = providers.$('.provider-field-group')
    const input = keyGroup.$('input[type="password"]')
    const status = keyGroup.$('.key-status')
    const test = keyGroup.$('button=Test key')
    await expect(input).toHaveValue('')
    await expect(status).toHaveText('saved')

    const requestsBeforeClick = keyRequests
    await test.click()
    await expect(status).toHaveText('Testing configured key…')
    await browser.waitUntil(async () => (await status.getText()) === 'Key looks valid', {
      timeout: 5_000,
      timeoutMsg: 'saved provider key was not validated',
    })

    assert.ok(keyRequests > requestsBeforeClick, 'Test key should make a fresh validation request')
    assert.equal(lastAuthorization, 'Bearer sk-or-e2e-key')
    await expect(input).toHaveValue('')
    await saveElementScreenshot('#settings-providers-host', 'settings-saved-provider-key.png')
  })
})
