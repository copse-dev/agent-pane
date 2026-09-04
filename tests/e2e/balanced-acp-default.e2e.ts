import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, seedOpenRouterFixture } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

const CLAUDE_ROUTE = 'acp:claude-acp#opus[1m]'
const OPENROUTER_ROUTE = 'openrouter:openai/gpt-5.6-sol'

async function startOpenRouterServer(): Promise<{ apiBase: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'openai/gpt-5.6-sol',
              name: 'OpenAI: GPT-5.6 Sol',
              context_length: 272000,
              pricing: { prompt: '0.000005', completion: '0.00003' },
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

describe('balanced new-thread default with subscription ACP agents', function () {
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
          id: 'claude-acp',
          title: 'Claude',
          command: 'claude-agent-acp',
          enabled: true,
          modelsProbedAt: Date.now(),
          availableModels: [
            {
              value: 'opus[1m]',
              label: 'Opus (1M context)',
              description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
            },
            {
              value: 'sonnet',
              label: 'Sonnet',
              description: 'Sonnet 5 · Efficient for routine tasks',
            },
          ],
        },
        {
          id: 'codex-acp',
          title: 'Codex',
          command: 'codex-acp',
          enabled: true,
          model: 'gpt-5.6-sol',
          modelsProbedAt: Date.now(),
          availableModels: [
            { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
            { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
          ],
        },
      ],
    })
    // Dynamic selectors short-circuit under the mock LLM. This spec never sends
    // a prompt, so exercise the production resolver while keeping every network
    // dependency on the local OpenRouter server and deterministic plan mock.
    writeE2eEnv({ COPSE_PANEL_MOCK_LLM: undefined, COPSE_PLAN_USAGE_MOCK: '1' })
    await browser.reloadSession()
  })

  after(async () => {
    writeE2eEnv({})
    resetUserData()
    if (fixture) await fixture.close()
  })

  it('settles on Claude ACP instead of flicking to the paid OpenRouter Sol route', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.project-new-thread-btn').click()

    const trigger = $('.model-picker-trigger[aria-label="Chat model"]')
    await browser.waitUntil(async () => (await trigger.getText()).includes('Claude Opus 5'), {
      timeout: 20_000,
      timeoutMsg: 'Balanced never resolved the new thread to Claude ACP',
    })
    // Re-check after the asynchronous OpenRouter catalog and plan-usage calls
    // have both had time to settle: this is the reported Opus -> paid Sol flick.
    await browser.pause(1_000)
    assert.ok((await trigger.getText()).includes('Claude Opus 5'))

    await trigger.click()
    const claude = $(`.model-picker-option[data-value="${CLAUDE_ROUTE}"]`)
    const paidSol = $(`.model-picker-option[data-value="${OPENROUTER_ROUTE}"]`)
    await expect(claude).toBeDisplayed()
    await expect(paidSol).toBeDisplayed()
    assert.equal(await claude.getAttribute('aria-selected'), 'true')
    assert.equal(await paidSol.getAttribute('aria-selected'), 'false')

    await prepareE2eScreenshot()
    await saveElementScreenshot('.model-picker-menu', 'balanced-acp-default-menu.png')
  })
})
