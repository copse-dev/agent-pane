import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('tool call display live mock', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    // Seed a deterministic cloud model so the run does not depend on resolving a
    // context window from an LM Studio server that is absent in CI (the default
    // model is `lmstudio:…`). The mock LLM is used regardless via
    // COPSE_PANEL_MOCK_LLM, so this only fixes the model-metadata path.
    seedEmptyProject(process.cwd(), 'e2e-live-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows a stable compact row for a fast tool', async function () {
    this.timeout(60_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    await browser.execute(() => {
      const state: { transitions: string[] } = { transitions: [] }
      ;(
        window as unknown as {
          __toolDisclosureTrace?: { transitions: string[] }
        }
      ).__toolDisclosureTrace = state
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (
            mutation.type === 'attributes' &&
            mutation.attributeName === 'open' &&
            mutation.target instanceof HTMLDetailsElement &&
            mutation.target.classList.contains('tool-card')
          ) {
            state.transitions.push(mutation.target.open ? 'open' : 'closed')
          }
        }
      }).observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['open'],
      })
    })

    await setComposerValue('list files please')
    await $('.submit-btn').click()

    await browser.waitUntil(
      async () => {
        const names = await browser.execute(() =>
          [...document.querySelectorAll('.tool-card .tool-name')].map(
            (element) => element.textContent,
          ),
        )
        return names.includes('Listed directory')
      },
      {
        timeout: 30_000,
        interval: 50,
        timeoutMsg: 'expected the completed list_dir label',
      },
    )
    await waitForAgentIdle()
    await browser.pause(1_400)

    await expect($('.tool-card-rollup')).toExist()
    await expect($('.tool-card-rollup')).not.toHaveAttribute('open')
    const trace = await browser.execute(
      () =>
        (
          window as unknown as {
            __toolDisclosureTrace?: { transitions: string[] }
          }
        ).__toolDisclosureTrace ?? null,
    )
    expect((trace?.transitions ?? []).join(',')).not.toContain('closed,open')

    await saveAppScreenshot('tool-display-live-mock.png')
  })
})
