import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('tool call display live mock', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
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

  it('shows human-readable single tool name', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    await setComposerValue('list files please')
    await $('.submit-btn').click()

    await expect($('.tool-card .tool-name')).toHaveText('List directory', { wait: 30_000 })

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'tool-display-live-mock.png'))
  })
})
