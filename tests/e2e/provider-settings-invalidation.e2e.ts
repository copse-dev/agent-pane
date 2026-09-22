import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-provider-settings-invalidation'
const STALE_ROUTE = 'acme:model-1'

async function assistantTranscript(): Promise<string> {
  return browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>('.msg-assistant .message-text')]
      .map((message) => message.innerText)
      .join('\n'),
  )
}

describe('stale custom-provider model selection', () => {
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
    seedEmptyProject(process.cwd(), PROJECT_ID, {
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
    await setComposerValue('Continue with the removed provider route.')
    await $('.submit-btn').click()

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

    await expect($('.stop-btn')).not.toBeDisplayed()
    await saveAppScreenshot('provider-settings-invalidated-route.png')
  })
})
