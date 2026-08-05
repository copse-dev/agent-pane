import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { $, browser } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedRemoteAgentModelsFixture } from './helpers/seed-config.ts'

const CURSOR_FIXTURE_PORT = 51236

const MODELS_PAYLOAD = {
  items: [
    {
      id: 'composer-2',
      displayName: 'Composer 2',
      variants: [{ params: [], displayName: 'Composer 2', isDefault: true }],
    },
    {
      id: 'claude-4.6-sonnet-thinking',
      displayName: 'Claude 4.6 Sonnet (Thinking)',
      variants: [{ params: [], displayName: 'Claude 4.6 Sonnet (Thinking)', isDefault: true }],
    },
  ],
}

async function startCursorModelsServer(): Promise<{
  apiBase: string
  close: () => Promise<void>
}> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.endsWith('/v1/models') || url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(MODELS_PAYLOAD))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const apiBase = await new Promise<string>((resolve, reject) => {
    server.once('error', reject)
    server.listen(CURSOR_FIXTURE_PORT, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${CURSOR_FIXTURE_PORT}`)
    })
  })
  return {
    apiBase,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

describe('remote agent model picker', () => {
  let fixture: { apiBase: string; close: () => Promise<void> } | null = null

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    fixture = await startCursorModelsServer()
    resetUserData()
    seedRemoteAgentModelsFixture(process.cwd(), { apiBase: fixture.apiBase })
    await browser.reloadSession()
  })

  after(async () => {
    resetUserData()
    if (fixture) await fixture.close()
  })

  it('lists Cursor Cloud Agent models from the live catalog under their own group', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    await $('.model-picker-trigger').click()
    await $('.model-picker-menu .model-picker-option').waitForExist({ timeout: 15_000 })
    await $('.model-picker-browse').click()
    await $('.model-picker-filter').waitForDisplayed({ timeout: 5_000 })

    const picker = await browser.execute(() => {
      const groupLabels = [
        ...document.querySelectorAll<HTMLElement>('.model-picker-group-label'),
      ].map((el) => el.textContent?.trim())
      const optionLabels = [
        ...document.querySelectorAll<HTMLButtonElement>('.model-picker-menu .model-picker-option'),
      ].map((el) => el.textContent?.trim() ?? '')
      return { groupLabels, optionLabels }
    })

    assert.ok(
      picker.groupLabels.includes('Cursor Cloud Agent'),
      `expected Cursor Cloud Agent group, saw ${JSON.stringify(picker.groupLabels)}`,
    )
    assert.ok(
      picker.optionLabels.includes('Default'),
      `expected Cursor Default row, saw ${JSON.stringify(picker.optionLabels)}`,
    )
    assert.ok(
      picker.optionLabels.includes('Composer 2'),
      `expected Composer 2 from live catalog, saw ${JSON.stringify(picker.optionLabels)}`,
    )
    // Cursor names it "Claude 4.6 Sonnet (Thinking)"; the picker spells Claude
    // models one way in every group.
    assert.ok(
      picker.optionLabels.includes('Claude Sonnet 4.6 (Thinking)'),
      `expected Claude thinking model from live catalog, saw ${JSON.stringify(picker.optionLabels)}`,
    )

    const menu = await $('.model-picker-menu')
    await saveElementScreenshot(menu, 'remote-agent-models-picker.png')
  })
})
