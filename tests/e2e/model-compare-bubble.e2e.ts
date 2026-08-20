import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// The offer-shaped entry point to a model comparison: a bubble above the
// composer whose click opens the model picker, instead of an approval modal
// arriving unbidden with the alert channels ringing. Its counterpart spec,
// model-compare-approval.e2e.ts, still covers the approval the *agent-initiated*
// `compare_models` tool raises — that path is unchanged.
describe('model comparison follow-up bubble', function () {
  this.timeout(60_000)

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    // `mockFollowUps` seeds the deterministic bubble set (which includes the
    // comparison bubble) without needing LM Studio, `gh`, or a dirty worktree.
    seedEmptyProject(process.cwd(), 'e2e-model-compare-bubble-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      modelComparisonEnabled: true,
      mockFollowUps: true,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('opens the model picker from the bubble instead of prompting', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await setComposerValue('make a small change')
    await $('.submit-btn').click()
    await waitForAgentIdle(20_000)

    const bubble = await $('.follow-up-bubble[data-id="compare-models"]')
    await bubble.waitForDisplayed({ timeout: 30_000 })
    await expect(bubble).toHaveText('Compare models')
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'model-compare-bubble.png'))

    await bubble.click()

    const dialog = await $('#comparison-model-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('h3')).toHaveText('Compare models on this diff')
    await expect(dialog.$('.approval-comparison-models')).toBeDisplayed()
    expect(await dialog.$$('.approval-model-select').length).toBe(3)
    expect(await dialog.$$('.approval-model-picker').length).toBe(3)
    await expect(dialog.$('.comparison-model-dialog-cost')).toHaveText(
      expect.stringContaining('Runs three model calls'),
    )

    // The approval prompt is what the bubble replaces — it must not be raised
    // just by opening the picker.
    await expect($('#approval-dialog')).not.toBeDisplayed()

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'model-compare-bubble-dialog.png'))

    await browser.waitUntil(
      async () => {
        const values = await dialog.$$('.approval-model-select').map((select) => select.getValue())
        return values.length === 3 && values.every((value) => value.length > 0)
      },
      { timeout: 30_000, timeoutMsg: 'comparison picker never loaded three concrete models' },
    )

    // Run is the consent: it must cross the real renderer → IPC → main path
    // without raising the spend approval that this foreground picker replaces.
    await dialog.$('.comparison-model-dialog-run').click()
    await expect(dialog).not.toBeDisplayed()
    await expect($('#approval-dialog')).not.toBeDisplayed()

    const card = await $('.comparison-panel')
    await card.waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => (await card.getAttribute('data-status')) !== 'running', {
      timeout: 30_000,
      timeoutMsg: 'comparison card stayed running',
    })
    await expect(card).toHaveAttribute('data-status', 'done')
    await expect($('#approval-dialog')).not.toBeDisplayed()
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'model-compare-bubble-result.png'))
  })
})
