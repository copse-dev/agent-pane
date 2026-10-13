import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, seedOpenRouterFixture } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

const PLAN_ROUTE = 'acp:claude-acp#opus'
const PAID_ROUTE = 'openrouter:anthropic/claude-fable-5'

async function startOpenRouterServer(): Promise<{ apiBase: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'openai/gpt-6.1-sol',
              name: 'OpenAI: GPT-6.1 Sol',
              context_length: 922000,
              pricing: { prompt: '0.000002', completion: '0.000010' },
              supported_parameters: ['tools'],
              architecture: { modality: 'text->text', output_modalities: ['text'] },
            },
            {
              id: 'anthropic/claude-fable-5',
              name: 'Anthropic: Claude Fable 5',
              context_length: 272000,
              pricing: { prompt: '0.000025', completion: '0.000125' },
              supported_parameters: ['tools'],
              architecture: { modality: 'text->text', output_modalities: ['text'] },
            },
          ],
        }),
      )
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
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('OpenRouter fixture did not bind a TCP port'))
        return
      }
      resolve(`http://127.0.0.1:${String(address.port)}/api/v1`)
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

describe('model value map respects subscription billing routes', function () {
  this.timeout(90_000)
  let fixture: { apiBase: string; close: () => Promise<void> } | null = null

  before(async () => {
    fixture = await startOpenRouterServer()
    resetUserData()
    seedOpenRouterFixture(process.cwd(), {
      apiBase: fixture.apiBase,
      model: 'auto:best-value',
      openRouterZdrOnly: false,
      registeredAcpAgents: [
        {
          id: 'claude-acp',
          title: 'Claude',
          command: 'claude-agent-acp',
          enabled: true,
          modelsProbedAt: Date.now(),
          availableModels: [{ value: 'opus', label: 'Opus', description: 'Claude Opus 5' }],
        },
      ],
    })
    writeE2eEnv({ COPSE_PANEL_MOCK_LLM: '0', COPSE_PLAN_USAGE_MOCK: '1' })
    await browser.reloadSession()
  })

  after(async () => {
    resetUserData()
    writeE2eEnv({})
    await fixture?.close()
  })

  it('selects included Opus and keeps paid Fable off the plan discount', async () => {
    assert.equal(await browser.execute(() => window.api.models.bestValueDefault()), PLAN_ROUTE)
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    const fieldset = $('.frontier-fieldset')
    await expect(fieldset.$('.frontier-chart svg')).toBeDisplayed()
    await expect(fieldset.$(`circle.frontier-point.plan[data-model-id="${PLAN_ROUTE}"]`)).toExist()
    const paid = fieldset.$(`circle.frontier-point[data-model-id="${PAID_ROUTE}"]`)
    await expect(paid).toExist()
    assert.equal((await paid.getAttribute('class')).split(' ').includes('plan'), false)
    assert.equal(
      await fieldset.$(`circle.frontier-plan-badge[data-model-id="${PAID_ROUTE}"]`).isExisting(),
      false,
    )

    // The hover text is what a user sees when comparing the expensive route.
    await fieldset.$(`circle.frontier-hit[data-model-id="${PAID_ROUTE}"]`).moveTo()
    const tooltip = fieldset.$('.frontier-tooltip')
    await expect(tooltip).toBeDisplayed()
    const text = await tooltip.getText()
    assert.doesNotMatch(text, /included in your plan/)
    assert.match(text, /\$45\/MTok/)
    await prepareE2eScreenshot()
    await saveElementScreenshot('.frontier-fieldset', 'settings-value-map-plan-routes.png')
  })
})

describe('Balanced keeps a newly advertised Sol model on Codex ACP', function () {
  this.timeout(90_000)
  let fixture: { apiBase: string; close: () => Promise<void> } | null = null

  before(async () => {
    fixture = await startOpenRouterServer()
    resetUserData()
    seedOpenRouterFixture(process.cwd(), {
      apiBase: fixture.apiBase,
      model: 'auto:balanced',
      openRouterZdrOnly: false,
      registeredAcpAgents: [
        {
          id: 'codex-acp',
          title: 'Codex',
          command: 'codex-acp',
          enabled: true,
          modelsProbedAt: Date.now(),
          availableModels: [{ value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }],
        },
      ],
    })
    writeE2eEnv({ COPSE_PANEL_MOCK_LLM: '0', COPSE_PLAN_USAGE_MOCK: '1' })
    await browser.reloadSession()
  })

  after(async () => {
    resetUserData()
    writeE2eEnv({})
    await fixture?.close()
  })

  it('resolves a new thread through Balanced and shows the included ACP route', async () => {
    const planRoute = 'acp:codex-acp#gpt-6.1-sol'
    assert.equal(
      await browser.execute(() => window.api.models.resolveDynamic('auto:balanced')),
      planRoute,
    )
    // Enter through the real new-thread action: seeding an already-resolved
    // ACP selection would not exercise the automatic default controller.
    await expect($('.chat-row.selected .chat-title')).toHaveText('Current Qwen thread')
    await $('.project-new-thread-btn').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('New Thread')
    await expect($('.model-picker-trigger')).toHaveText('GPT-6.1 Sol', { containing: true })
    await expect($('.model-picker-trigger .model-picker-label')).toHaveAttribute('title', planRoute)
    await prepareE2eScreenshot()
    await saveElementScreenshot('#input-bar', 'balanced-new-thread-codex-sol.png')

    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    const fieldset = $('.frontier-fieldset')
    await expect(
      fieldset.$(`circle.frontier-point.plan.estimated[data-model-id="${planRoute}"]`),
    ).toExist()
    await expect(
      fieldset.$('circle.frontier-point[data-model-id="openrouter:openai/gpt-6.1-sol"]'),
    ).not.toExist()
    await fieldset.$(`circle.frontier-hit[data-model-id="${planRoute}"]`).moveTo()
    await expect(fieldset.$('.frontier-tooltip')).toHaveText('included', { containing: true })
    await expect(fieldset.$('.frontier-tooltip .tt-line strong')).toHaveText('~', {
      containing: true,
    })
    await prepareE2eScreenshot()
    await saveElementScreenshot('.frontier-fieldset', 'settings-value-map-codex-sol-launch.png')
  })
})
