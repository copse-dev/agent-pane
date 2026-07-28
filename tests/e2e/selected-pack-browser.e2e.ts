import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

const PACK_ID = 'personal.browser-fixture'
const MODEL_ID = 'browser'
const PROJECT_ID = 'e2e-selected-pack-browser'

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

describe('selected pack browser behavior', function () {
  this.timeout(90_000)
  let server: Server | null = null
  let packRoot = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html>
        <html>
          <head><title>Personal reference desk</title></head>
          <body>
            <h1>Personal reference desk</h1>
            <p>This local page stands in for an explicitly declared website.</p>
            <button type="button">Review current task</button>
            <label>Image evidence <input type="file" accept="image/*"></label>
          </body>
        </html>`)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP port.')
    const origin = `http://127.0.0.1:${String(address.port)}`

    packRoot = mkdtempSync(join(tmpdir(), 'copse-e2e-browser-pack-'))
    mkdirSync(join(packRoot, 'dist'))
    writeFileSync(
      join(packRoot, 'dist', 'index.mjs'),
      `export function activate(api) {
        api.registerModelRoute(${JSON.stringify(MODEL_ID)}, async (_turn, context) => {
          const tab = await context.browser.open(${JSON.stringify(`${origin}/reference`)})
          const snapshot = await context.browser.snapshot(tab.tabId)
          return { text: 'Visible browser handoff completed.\\n\\n' + snapshot }
        })
      }
`,
    )
    writeFileSync(
      join(packRoot, 'copse-pack.json'),
      JSON.stringify({
        name: PACK_ID,
        version: '0.1.0',
        description: 'Neutral selected-pack browser fixture.',
        models: {
          provides: [{ id: MODEL_ID, label: 'Personal reference browser' }],
        },
        browser: { origins: [origin] },
        runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
      }),
    )

    seedEmptyProject(process.cwd(), PROJECT_ID, {
      packSources: [packRoot],
      model: `pack-model:${PACK_ID}:${MODEL_ID}`,
    })
    await browser.reloadSession()
  })

  after(async () => {
    resetUserData()
    if (packRoot) rmSync(packRoot, { recursive: true, force: true })
    await closeServer(server)
  })

  it('opens the declared page in a visible tab and returns its snapshot', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await setComposerValue('Inspect my personal reference page.')
    await $('.submit-btn').click()
    await waitForAgentIdle(60_000)

    const assistant = $('.msg-assistant .message-text')
    await assistant.waitForDisplayed({ timeout: 30_000 })
    const response = await assistant.getText()
    assert.match(response, /Visible browser handoff completed/)
    assert.match(response, /Personal reference desk/)
    assert.match(response, /Review current task/)

    await expect($('#pane-files')).toBeDisplayed()
    await expect($('.browser-tabs-tab.is-active')).toBeDisplayed()
    const addressInput = $('.browser-tab-panel.is-active .browser-url-input')
    await browser.waitUntil(async () => (await addressInput.getValue()).length > 0, {
      timeout: 10_000,
      timeoutMsg: 'expected host-driven navigation to update the visible address bar',
    })
    const address = await addressInput.getValue()
    assert.match(address, /^http:\/\/127\.0\.0\.1:\d+\/reference$/)

    await saveElementScreenshot('#app', 'selected-pack-browser-tab.png')
  })
})
