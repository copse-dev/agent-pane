import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedWorktreePreparationFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveChatPaneScreenshot } from './helpers/screenshot.ts'

describe('worktree preparation tool cards', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedWorktreePreparationFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the readiness transition with human-readable labels and remediation', async () => {
    const preflight = $('[data-tool-id="tc-preflight-worktree"]')
    const prepare = $('[data-tool-id="tc-prepare-worktree"]')
    await preflight.waitForExist({ timeout: 30_000 })
    await expect($$('.tool-card')).toBeElementsArrayOfSize(2)
    await expect(preflight.$('.tool-name')).toHaveText('Checked worktree')
    await expect(prepare.$('.tool-name')).toHaveText('Prepared worktree')
    await expect(preflight).toHaveAttribute('data-status', 'done')
    await expect(prepare).toHaveAttribute('data-status', 'done')

    await preflight.$('summary.tool-card-header').click()
    await prepare.$('summary.tool-card-header').click()
    await expect(preflight.$('.tool-result')).toHaveText('Worktree preparation: absent', {
      containing: true,
    })
    await expect(preflight.$('.tool-result')).toHaveText('Run prepare_worktree once', {
      containing: true,
    })
    await expect(prepare.$('.tool-result')).toHaveText('Worktree preparation: ready', {
      containing: true,
    })
    await expect(prepare.$('.tool-result')).toHaveText('ChromeDriver 44.0.0 ready', {
      containing: true,
    })

    await saveChatPaneScreenshot('worktree-preparation-tools.png')
  })
})
