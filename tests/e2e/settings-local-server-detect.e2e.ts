import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

// Visual eval: selecting a local provider in Settings probes the default local-server
// endpoints and puts the green "set up" dot on every chip whose server answers,
// with no key saved. A stand-in OpenAI-compatible server plays Ollama (:11434).
describe('local server detection (Settings → Providers)', () => {
  let server: Server | undefined

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(req.url?.endsWith('/models') ? JSON.stringify({ data: [{ id: 'llama3' }] }) : '{}')
    })
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject)
      server?.listen(11434, '127.0.0.1', resolve)
    })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-local-server-detect')
    await browser.reloadSession()
  })

  after(async () => {
    resetUserData()
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  })

  it('dots a running local server without a saved key', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()
    const host = $('#settings-providers-host')
    await expect(host).toBeDisplayed()

    await host.$('.provider-chip[data-provider="ollama"]').click()
    const ollamaDot = host.$('.provider-chip[data-provider="ollama"] .provider-chip-dot')
    await ollamaDot.waitForExist({ timeout: 15_000, timeoutMsg: 'running Ollama never got a dot' })
    assert.equal(await ollamaDot.getAttribute('title'), 'Set up')
    assert.equal(
      await host.$('.provider-chip[data-provider="jan"] .provider-chip-dot').isExisting(),
      false,
    )

    const chips = host.$('.provider-chips')
    await chips.scrollIntoView({ block: 'center' })
    await expect(ollamaDot).toBeDisplayed()
    await saveElementScreenshot(
      '#settings-providers-host .provider-chips',
      'settings-local-server-detect.png',
    )
  })
})
