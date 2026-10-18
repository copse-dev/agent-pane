import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, seedOpenRouterFixture } from './helpers/seed-config.ts'
import {
  pinTextForCapture,
  prepareE2eScreenshot,
  saveElementScreenshot,
  waitForSettledLayout,
} from './helpers/screenshot.ts'

const PLAN_ROUTE = 'acp:claude-acp#opus'
const PAID_ROUTE = 'openrouter:anthropic/claude-fable-5'

/** Capture the real hover after framing; earlier hovers can be lost to capture scrolling. */
async function captureRouteTooltip(
  modelId: string,
  filename: string,
  assertContent: (text: string) => void,
  pinPlanReset = false,
): Promise<void> {
  let restoreResetDay: (() => Promise<void>) | undefined
  // Electron resizeTo restores the content viewport; outer bounds include the
  // native frame (8×4 px on Linux) and grow again if used as content dimensions.
  const originalWindow = await browser.execute(() => ({
    width: innerWidth,
    height: innerHeight,
  }))
  try {
    // The taller frame contains the whole plot and its full score/price/Card tooltip.
    // A fully visible element also prevents WebDriver's element capture from scrolling it.
    await browser.execute(() => window.resizeTo(1200, 1000))
    await browser.waitUntil(
      async () => browser.execute(() => innerWidth >= 1180 && innerHeight >= 960),
      { timeout: 10_000, timeoutMsg: 'the tooltip fixture requires a real 1200×1000 window' },
    )
    await prepareE2eScreenshot({ width: 1200, height: 1000 })
    await browser.execute(() => {
      document.querySelector('.frontier-fieldset')?.scrollIntoView({
        behavior: 'instant',
        block: 'start',
      })
    })
    await waitForSettledLayout('.frontier-fieldset')
    await saveElementScreenshot('.frontier-fieldset', filename, {
      frame: 'document',
      beforeCapture: async () => {
        // Resolve through the existing deterministic probe boundary, then wait for the
        // renderer's async cache to expose that same card rather than omitting it.
        const card = await browser.execute(async (id) => {
          const cards = await window.api.modelCards.resolve([id])
          return cards[id]
        }, modelId)
        assert.ok(card, 'the advertised model has its resolved system card')
        await browser.waitUntil(
          async () => {
            const fieldset = $('.frontier-fieldset')
            await fieldset.$(`circle.frontier-hit[data-model-id="${modelId}"]`).moveTo()
            const tooltip = fieldset.$('.frontier-tooltip')
            if (!(await tooltip.isDisplayed())) return false
            const link = tooltip.$('.tt-card-link')
            return (await link.isExisting()) && (await link.getAttribute('href')) === card.url
          },
          { timeout: 15_000, timeoutMsg: 'the final framed hover never exposed its resolved Card' },
        )
        const tooltip = $('.frontier-fieldset .frontier-tooltip')
        assertContent(await tooltip.getText())
        await expect(tooltip.$('.tt-card-link')).toHaveText(card.title)

        if (pinPlanReset) {
          const plan = await browser.execute(async () => {
            const snapshot = await window.api.usage.getPlanUsage()
            const provider = snapshot.providers.find((p) => p.provider === 'codex')
            if (provider?.status !== 'ok') throw new Error('Codex fixture plan is unavailable')
            const primary = provider.usage.windows.find((w) => w.id === 'primary')
            if (!primary?.resetsAt) throw new Error('Codex plan has no reset time')
            return {
              usedPercent: primary.usedPercent,
              resetIsFuture: Date.parse(primary.resetsAt) > Date.now(),
              weekday: new Date(primary.resetsAt).toLocaleDateString(undefined, {
                weekday: 'short',
              }),
            }
          })
          assert.equal(plan.usedPercent, 11)
          assert.ok(plan.resetIsFuture, 'the seeded plan reset is still in the future')
          await expect(tooltip).toHaveText(
            expect.stringContaining(`11% of this plan window used, resets ${plan.weekday}.`),
          )
          restoreResetDay = await pinTextForCapture(
            '.frontier-tooltip-content',
            /(?<=11% of this plan window used, resets )[A-Za-z]+(?=\.)/g,
            'Mon',
          )
        }

        // Observe descendant geometry and scroll clipping, not just the fieldset's
        // outer bounds. Reject a timeout instead of saving a partial/hidden tooltip.
        const settled = await browser.execute(async () => {
          const deadline = performance.now() + 3_000
          let previous = ''
          let stable = 0
          while (performance.now() < deadline) {
            const host = document.querySelector('.frontier-fieldset')
            const tip = host?.querySelector<HTMLElement>('.frontier-tooltip')
            if (!host || !tip || tip.hidden) return false
            const rect = host.getBoundingClientRect()
            const t = tip.getBoundingClientRect()
            let visible =
              rect.top >= 0 &&
              rect.left >= 0 &&
              rect.bottom <= window.innerHeight &&
              rect.right <= window.innerWidth &&
              t.width > 0 &&
              t.height > 0 &&
              t.top >= rect.top &&
              t.left >= rect.left &&
              t.bottom <= rect.bottom &&
              t.right <= rect.right
            for (let parent = host.parentElement; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent)
              const bounds = parent.getBoundingClientRect()
              if (
                style.overflowX !== 'visible' &&
                (rect.left < bounds.left + parent.clientLeft ||
                  rect.right > bounds.left + parent.clientLeft + parent.clientWidth)
              )
                visible = false
              if (
                style.overflowY !== 'visible' &&
                (rect.top < bounds.top + parent.clientTop ||
                  rect.bottom > bounds.top + parent.clientTop + parent.clientHeight)
              )
                visible = false
            }
            const snapshot = [host, ...host.querySelectorAll('*')]
              .map((node) => {
                const r = node.getBoundingClientRect()
                return [r.top, r.left, r.width, r.height, node.scrollTop, node.scrollLeft].join(',')
              })
              .join(';')
            stable = visible && snapshot === previous ? stable + 1 : 0
            if (stable >= 3) return true
            previous = snapshot
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          }
          return false
        })
        const bounds = await browser.execute(() => {
          const host = document.querySelector('.frontier-fieldset')!
          const tip = host.querySelector('.frontier-tooltip')!
          return {
            viewport: [innerWidth, innerHeight],
            host: host.getBoundingClientRect().toJSON(),
            tooltip: tip.getBoundingClientRect().toJSON(),
            ancestors: Array.from(
              (function* () {
                for (let p = host.parentElement; p; p = p.parentElement) yield p
              })(),
            ).map((p) => ({
              tag: p.tagName,
              id: p.id,
              class: p.className,
              rect: p.getBoundingClientRect().toJSON(),
              client: [p.clientWidth, p.clientHeight],
              overflow: [getComputedStyle(p).overflowX, getComputedStyle(p).overflowY],
            })),
          }
        })
        assert.ok(
          settled,
          `the full plot and complete tooltip fit the saved frame and settled: ${JSON.stringify(bounds)}`,
        )
        assertContent(await tooltip.getText())
        await expect(tooltip.$('.tt-card-link')).toHaveText(card.title)
      },
    })
  } finally {
    await restoreResetDay?.()
    await browser.execute((size) => window.resizeTo(size.width, size.height), originalWindow)
    await browser.waitUntil(
      async () =>
        browser.execute(
          (size) => innerWidth === size.width && innerHeight === size.height,
          originalWindow,
        ),
      {
        timeout: 10_000,
        timeoutMsg: 'the tooltip fixture did not restore the original window size',
      },
    )
    await prepareE2eScreenshot()
  }
}

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
    // This route is over four times the price of an equally capable model,
    // so it belongs in the disclosure rather than on the default chart.
    await expect(fieldset.$(`circle.frontier-point[data-model-id="${PAID_ROUTE}"]`)).not.toExist()
    await expect(
      fieldset.$(`circle.frontier-plan-badge[data-model-id="${PAID_ROUTE}"]`),
    ).not.toExist()
    const disclosure = fieldset.$('details.frontier-severely-dominated')
    await expect(disclosure).toExist()
    await disclosure.$('summary').click()
    const text = await disclosure.getText()
    assert.match(text, /Fable 5/)
    assert.match(text, /\$45/)
    assert.doesNotMatch(text, /included in your plan/)
    assert.match(text, /\$45\/MTok/)
    await captureRouteTooltip(PAID_ROUTE, 'settings-value-map-plan-routes.png', (captured) => {
      assert.match(captured, /Claude Fable 5/)
      assert.doesNotMatch(captured, /included in your plan/)
      assert.match(captured, /\$45\/MTok/)
    })
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
    await captureRouteTooltip(
      planRoute,
      'settings-value-map-codex-sol-launch.png',
      (captured) => {
        assert.match(captured, /gpt-6-1-sol/)
        assert.match(captured, /included in your plan/)
        assert.match(captured, /~63\.5/)
        assert.match(captured, /~\$0 marginal token cost/)
      },
      true,
    )
  })
})
