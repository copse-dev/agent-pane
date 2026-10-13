import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-thread-worktree-composer'

describe('first-message checkout composer', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
  })

  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-thread-worktree-composer-'))
    resetUserData()
    // Deliberately not a Git repository: explicit isolation must surface a
    // retryable inline error without dispatching the first prompt.
    seedEmptyProject(workspaceRoot, PROJECT_ID)
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
    delete process.env['COPSE_PANEL_MOCK_LLM']
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['OPENAI_API_KEY']
  })

  it('shows checkout choices and keeps a failed isolated prompt ready to retry', async () => {
    const choice = $('.footer-checkout-btn')
    await choice.waitForDisplayed({ timeout: 10_000 })
    await expect(choice).toHaveText('Shared checkout')

    await choice.click()
    await expect($('.footer-checkout-menu')).toBeDisplayed()
    await expect($('[data-checkout-choice="shared"]')).toHaveText('Shared checkout')
    await expect($('[data-checkout-choice="worktree"]')).toHaveText('Isolated worktree')
    await saveAppScreenshot('thread-worktree-checkout-menu.png')

    await $('[data-checkout-choice="worktree"]').click()
    await expect(choice).toHaveText('Isolated worktree')
    await setComposerValue('Keep this prompt after allocation fails')
    await $('.submit-btn').click()

    const error = $('.composer-checkout-error')
    await error.waitForDisplayed({ timeout: 15_000 })
    await expect(error).toHaveText(expect.stringContaining('not git'))
    await expect($('.composer-checkout-retry-btn')).toHaveText('Retry')
    assert.equal(await $('.prompt-input').getText(), 'Keep this prompt after allocation fails')
    assert.equal(await $$('.msg-user').length, 0, 'failed preparation must not add a prompt')
    await expect(choice).toHaveText('Isolated worktree')
    await saveAppScreenshot('thread-worktree-checkout-error.png')
  })
})
