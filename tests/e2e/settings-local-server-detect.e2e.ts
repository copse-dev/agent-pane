import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

// Visual eval: opening Settings probes the local model-server endpoints and lists
// every server that answers as a "Running" row in Models & agents, with no key
// saved; Options opens that server's own form, and + Add → Model server offers
// the ones not yet listed. A stand-in OpenAI-compatible server plays Ollama
// (:11434).
describe('local server detection (Settings → Models & agents)', () => {
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

  it('lists a running local server without a saved key', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()
    const list = $('[data-testid="models-agents-fieldset"]')
    await expect(list).toBeDisplayed()

    const ollama = list.$('[data-row="server:ollama"]')
    await ollama.waitForExist({ timeout: 15_000, timeoutMsg: 'running Ollama was never listed' })
    await expect(ollama.$('.acp-row-chip')).toHaveText('Running')
    assert.equal(await list.$('[data-row="server:jan"]').isExisting(), false)

    await ollama.$('button=Options').click()
    await expect(ollama.$('button=Fetch models')).toBeDisplayed()
    await ollama.$('button=Hide options').click()
    await ollama.scrollIntoView({ block: 'center' })
    await saveAppScreenshot('settings-local-server-detect.png')

    // The Add menu offers the servers that are not listed yet, plus a custom URL.
    await list.$('[data-testid="connections-add-toggle"]').click()
    await list.$('.acp-add-row[data-add="server"]').$('button=Connect').click()
    const choice = list.$('[data-testid="connections-server-choice"]')
    await expect(choice).toBeDisplayed()
    const values = await browser.execute(() =>
      [
        ...document.querySelectorAll<HTMLOptionElement>(
          '[data-testid="connections-server-choice"] option',
        ),
      ].map((option) => option.value),
    )
    assert.ok(!values.includes('ollama'), `Ollama is already listed: ${JSON.stringify(values)}`)
    assert.ok(values.includes('lmstudio') && values.includes('jan'))
    assert.equal(values.at(-1), 'other')
  })
})
