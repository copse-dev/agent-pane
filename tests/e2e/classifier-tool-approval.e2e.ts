import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { CLASSIFIER_PRESETS } from '@copse/llm/classifiers/presets.ts'
import { submitComposer } from './helpers/composer.ts'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import {
  readSeededSettings,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSettings,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('agent classifier approval', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-classifier-tool-approval', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    const profile = CLASSIFIER_PRESETS.find((item) => item.id === 'typesafe')
    assert.ok(profile)
    writeSettings({
      ...readSeededSettings(),
      classifierProviders: { version: 1, profiles: [profile] },
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('offers a single classifier grant with the exact input behind details', async () => {
    await prepareMockToolTurn(
      'Classify this TypeScript snippet.',
      {
        name: 'ask_classifier',
        args: {
          classifier: 'typesafe',
          text: 'const value = JSON.parse(input) as UserSettings;',
          type: 'boolean',
          question: 'Does this use an unchecked assertion?',
        },
      },
      'The classifier request was declined.',
    )
    await submitComposer()

    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Allow agent classifier use?')
    await expect(dialog.$('.approval-approve')).toHaveText('Allow classifiers')
    await expect(dialog.$('.approval-footer')).toHaveText(
      expect.stringContaining('future agent calls to any configured classifier'),
    )
    expect(await dialog.$('.approval-body').isDisplayed()).toBe(false)
    expect(await dialog.$('.approval-approve-once').isDisplayed()).toBe(false)
    await saveAppScreenshot('classifier-tool-approval-collapsed.png')

    await dialog.$('.approval-details-toggle').click()
    await expect(dialog.$('.approval-body')).toHaveText(
      expect.stringContaining('const value = JSON.parse(input) as UserSettings;'),
    )
    await expect(dialog.$('.approval-approve-once')).toHaveText('Allow once')
    await saveAppScreenshot('classifier-tool-approval-expanded.png')
    await dialog.$('.approval-reject').click()
  })
})
