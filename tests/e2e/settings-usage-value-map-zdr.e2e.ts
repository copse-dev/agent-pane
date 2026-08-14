import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedOpenRouterFixture } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

const OPENROUTER_FIXTURE_PORT = 51239

async function startOpenRouterServer(): Promise<{ apiBase: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'openai/gpt-4o',
              name: 'GPT-4o',
              context_length: 128000,
              pricing: { prompt: '0.0000025', completion: '0.00001' },
              supported_parameters: ['tools'],
              architecture: { modality: 'text->text', output_modalities: ['text'] },
            },
          ],
        }),
      )
      return
    }
    if (url.endsWith('/endpoints/zdr')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ model_name: 'GPT-4o', name: 'OpenAI | GPT-4o' }] }))
      return
    }
    if (url.endsWith('/key')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { label: 'e2e-key', usage: 0, limit: null } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const apiBase = await new Promise<string>((resolve, reject) => {
    server.once('error', reject)
    server.listen(OPENROUTER_FIXTURE_PORT, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${String(OPENROUTER_FIXTURE_PORT)}/api/v1`)
    })
  })
  return {
    apiBase,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

describe('settings usage model value map ZDR filter', () => {
  let fixture: { apiBase: string; close: () => Promise<void> } | null = null

  before(async () => {
    fixture = await startOpenRouterServer()
    resetUserData()
    seedOpenRouterFixture(process.cwd(), { apiBase: fixture.apiBase })
    await browser.reloadSession()
  })

  after(async () => {
    resetUserData()
    if (fixture) await fixture.close()
  })

  it('filters the value map to zero-retention paths and screenshots the result', async () => {
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    const fieldset = $('.frontier-fieldset')
    await expect(fieldset).toBeDisplayed()

    const zdrBtn = fieldset.$('button.frontier-zdr-toggle')
    await expect(zdrBtn).toBeDisplayed()
    assert.equal(await zdrBtn.getAttribute('aria-pressed'), 'false')

    const chart = fieldset.$('.frontier-chart svg')
    await expect(chart).toBeDisplayed()
    await chart.$('circle.frontier-hit').waitForExist({
      timeout: 20_000,
      timeoutMsg: 'value-map points never rendered',
    })
    assert.match(await chart.getText(), /claude-|gpt-/i)

    // Settings footer Save/Cancel can cover the control until scrolled into view.
    await fieldset.scrollIntoView()
    await zdrBtn.scrollIntoView()
    await zdrBtn.click()
    await browser.waitUntil(async () => (await zdrBtn.getAttribute('aria-pressed')) === 'true', {
      timeout: 5000,
      timeoutMsg: 'ZDR only toggle did not activate',
    })

    const filteredChart = fieldset.$('.frontier-chart svg')
    const openRouterPoint = filteredChart.$(
      'circle.frontier-point[data-model-id="openrouter:openai/gpt-4o"]',
    )
    await openRouterPoint.waitForExist({
      timeout: 5000,
      timeoutMsg: 'OpenRouter ZDR route never appeared in the value map',
    })
    const filteredText = await filteredChart.getText()
    assert.doesNotMatch(filteredText, /claude-opus-4-8|claude-fable-5|gpt-5\.5/)
    assert.match(filteredText, /gpt-4o/i)
    await expect(openRouterPoint).toExist()

    await prepareE2eScreenshot()
    await saveElementScreenshot('.frontier-fieldset', 'settings-usage-value-map-zdr.png')

    const noTrainingBtn = fieldset.$('button.frontier-no-training-toggle')
    await expect(noTrainingBtn).toBeDisplayed()

    // The local OpenRouter fixture uses its real ZDR routing setting, so it is
    // also valid under the broader no-training filter. Provider replacement is
    // covered deterministically in the panel component test; an e2e key for a
    // direct provider would be rejected by the real product validation gate.
    await zdrBtn.click()
    await noTrainingBtn.click()
    await browser.waitUntil(
      async () => (await noTrainingBtn.getAttribute('aria-pressed')) === 'true',
      { timeout: 5000, timeoutMsg: 'No training toggle did not activate' },
    )
    const noTrainingChart = fieldset.$('.frontier-chart svg')
    const noTrainingOpenRouterPoint = noTrainingChart.$(
      'circle.frontier-point[data-model-id="openrouter:openai/gpt-4o"]',
    )
    await noTrainingOpenRouterPoint.waitForExist({
      timeout: 5000,
      timeoutMsg: 'OpenRouter no-training route never appeared in the value map',
    })
    assert.match(await noTrainingChart.getText(), /gpt-4o/i)
    await expect(noTrainingOpenRouterPoint).toExist()

    await prepareE2eScreenshot()
    await saveElementScreenshot('.frontier-fieldset', 'settings-usage-value-map-privacy.png')
  })
})
