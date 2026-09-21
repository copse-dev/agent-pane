import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { $, browser, expect } from '@wdio/globals'
import { getIntellectScore } from '@copse/llm/model-intellect.ts'
import { resetUserData, seedOpenRouterFixture } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

const BUILD_ROUTE = 'openrouter:x-ai/grok-build-0.1'
const AGENT_ROUTE = 'acp:cursor#grok-build-0.1'

describe('Grok model labels and scores across providers', function () {
  this.timeout(60_000)
  let close: (() => Promise<void>) | undefined

  before(async () => {
    const server = createServer((req, res) => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [
              { id: 'x-ai/grok-build-0.1', name: 'xAI: Grok Build 0.1' },
              { id: 'x-ai/grok-4.3', name: 'SpaceXAI: Grok 4.3' },
            ].map((model) => ({
              ...model,
              context_length: 256000,
              pricing: { prompt: '0.000001', completion: '0.000002' },
              supported_parameters: ['tools'],
              architecture: { modality: 'text->text', output_modalities: ['text'] },
            })),
          }),
        )
        return
      }
      if (req.url?.endsWith('/key')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: { label: 'e2e-key', usage: 0, limit: null } }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    close = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    resetUserData()
    seedOpenRouterFixture(process.cwd(), {
      apiBase: `http://127.0.0.1:${String(address.port)}/api/v1`,
      registeredAcpAgents: [
        {
          id: 'cursor',
          title: 'Cursor',
          command: 'cursor-agent',
          enabled: true,
          modelsProbedAt: Date.now(),
          availableModels: [
            { value: 'grok-build-0.1', label: 'grok-build-0.1' },
            { value: 'grok-4.3', label: 'grok-4.3' },
          ],
        },
      ],
    })
    await browser.reloadSession()
  })

  after(async () => {
    resetUserData()
    await close?.()
  })

  it('shows matching names and the Build measurement without changing route identity', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('.model-picker-trigger').click()
    await $('.model-picker-browse').click()
    await $('.model-picker-filter').setValue('grok')
    const score = getIntellectScore('grok-build-0-1-06-16')
    assert.ok(score)
    const expected = `Grok Build 0.1 — intellect ${score.estimated ? '~' : ''}${String(score.value)}`
    for (const route of [BUILD_ROUTE, AGENT_ROUTE]) {
      await expect($(`.model-picker-option[data-value="${route}"]`)).toHaveText(expected)
    }
    for (const route of ['openrouter:x-ai/grok-4.3', 'acp:cursor#grok-4.3']) {
      await expect($(`.model-picker-option[data-value="${route}"]`)).toHaveText('Grok 4.3')
    }
    await prepareE2eScreenshot()
    await saveElementScreenshot('.model-picker-menu', 'grok-model-picker.png')
    await $(`.model-picker-option[data-value="${AGENT_ROUTE}"]`).click()
    await expect($('.model-picker-trigger')).toHaveText(/Grok Build 0.1/)
    await browser.waitUntil(
      async () => {
        const selected = await browser.execute(async () => {
          const threads = await window.api.threads.loadProject('e2e-openrouter-project')
          return threads.find((thread) => thread.id === 'e2e-openrouter-qwen')?.model
        })
        return selected === AGENT_ROUTE
      },
      { timeout: 5_000, timeoutMsg: 'expected the selected route to persist on the active thread' },
    )
  })
})
