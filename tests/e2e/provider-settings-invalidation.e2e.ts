import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-provider-settings-invalidation'
const STALE_ROUTE = 'acme:model-1'

async function assistantTranscript(): Promise<string> {
  return browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>('.msg-assistant .message-text')]
      .map((message) => message.innerText)
      .join('\n'),
  )
}

describe('stale custom-provider model selection', function () {
  this.timeout(90_000)
  before(async () => {
    // Mock mode short-circuits provider selection, so turn it off through the
    // supported Electron-shell environment before reload. No provider key or
    // custom provider is seeded: the stale route must fail in main before any
    // provider client can be constructed or make a model request.
    writeE2eEnv({
      COPSE_PANEL_MOCK_LLM: '0',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    })
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), PROJECT_ID, {
      model: STALE_ROUTE,
      subagentsEnabled: false,
    })
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({})
    resetUserData()
  })

  it('shows actionable guidance without starting a provider turn', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('#confirm-dialog').waitForDisplayed({ timeout: 20_000 })
    await expect($('.confirm-dialog-message')).toHaveText('Model settings need attention')
    await expect($('.confirm-dialog-detail')).toHaveText(expect.stringContaining(STALE_ROUTE))
    await saveElementScreenshot('#confirm-dialog', 'provider-settings-proactive-warning.png')
    await $('.confirm-dialog-confirm').click()
    await $('#settings-dialog').waitForDisplayed()
    await browser
      .waitUntil(
        async () =>
          (await browser.execute(() =>
            document.activeElement?.getAttribute('data-model-setting-target'),
          )) === 'model',
        { timeout: 30_000 },
      )
      .catch(async () => {
        const state = await browser.execute(() => ({
          focused: document.activeElement?.outerHTML,
          activeSection: document
            .querySelector('.settings-section.active')
            ?.getAttribute('data-section'),
          targets: [...document.querySelectorAll<HTMLElement>('[data-model-setting-target]')].map(
            (entry) => ({
              target: entry.dataset['modelSettingTarget'],
              visible: entry.getClientRects().length > 0,
            }),
          ),
          failures: document
            .querySelector('#settings-dialog')
            ?.getAttribute('data-settings-refresh-failed'),
        }))
        assert.fail(`Model recovery focus did not settle: ${JSON.stringify(state)}`)
      })
    const control = $('[data-model-setting-target="model"]')
    const location = await control.getLocation()
    assert.ok(location.y >= 0 && location.y < 650, 'the exact model control should be in view')
    await saveAppScreenshot('provider-settings-recovery.png')
    await $('#settings-close').click()
    await setComposerValue('Continue with the removed provider route.')
    await submitComposer()

    const errorText = `The provider for ${STALE_ROUTE} is no longer configured.`
    await browser.waitUntil(async () => (await assistantTranscript()).includes(errorText), {
      timeout: 20_000,
      timeoutMsg: 'stale-provider guidance never reached the transcript',
    })
    await waitForAgentIdle(20_000)

    const transcript = await assistantTranscript()
    assert.match(transcript, new RegExp(`provider for ${STALE_ROUTE} is no longer configured`, 'i'))
    assert.match(transcript, /Choose a configured model using the model picker/i)
    // A response or usage chunk would mean the turn escaped the main-process
    // provider-selection guard. This error-only transcript is the live boundary
    // before any provider client is asked to stream a model response.
    assert.ok(transcript.includes(errorText))
    // The failure is the app's error callout, not answer prose: no generic
    // "An error occurred:" lead-in and no second copy of the text outside it.
    assert.doesNotMatch(transcript, /An error occurred/i)
    const placement = await browser.execute((text) => {
      const messages = [...document.querySelectorAll<HTMLElement>('.msg-assistant .message-text')]
      const callouts = messages.flatMap((message) => [
        ...message.querySelectorAll<HTMLElement>('blockquote.markdown-alert-caution'),
      ])
      const occurrences = messages.reduce(
        (count, message) => count + message.innerText.split(text).length - 1,
        0,
      )
      return {
        callouts: callouts.length,
        calloutHasText: callouts.some((callout) => callout.innerText.includes(text)),
        occurrences,
      }
    }, errorText)
    assert.equal(placement.callouts, 1)
    assert.ok(placement.calloutHasText, 'stale-provider guidance should render inside the callout')
    assert.equal(placement.occurrences, 1)

    await expect($('.stop-btn')).not.toBeDisplayed()
    // Submitting makes this chat's selected route explicit; dismiss its own
    // scoped warning before recording the main-process fail-safe callout.
    const warning = $('#confirm-dialog')
    if (await warning.isDisplayed()) await $('.confirm-dialog-cancel').click()
    await saveAppScreenshot('provider-settings-invalidated-route.png')
  })
})
