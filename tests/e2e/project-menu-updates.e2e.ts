import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { prepareMockTurn, expectAssistantReply } from './helpers/mock-scenario.ts'
import { submitComposer } from './helpers/composer.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const PROJECT = 'project-menu-updates'

describe('project menu during background updates', function () {
  this.timeout(90_000)
  let root = ''
  let barrier = ''

  before(async () => {
    resetUserData()
    root = mkdtempSync(join(tmpdir(), 'copse-menu-notes-'))
    barrier = mkdtempSync(join(tmpdir(), 'copse-menu-barrier-'))
    seedEmptyProject(root, PROJECT, { model: 'claude-sonnet-4-6' })
    writeE2eEnv({ COPSE_E2E_PROJECT_MENU_BARRIER: barrier })
    writeSeedConfig({
      projects: [{ id: PROJECT, path: root, name: 'Menu notes' }],
      activeProjectId: PROJECT,
      activeThreadId: 'notes',
      [`threads:${PROJECT}`]: [
        {
          id: 'notes',
          title: 'Checking notes',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      pluginDisabled: [],
      pluginMigration: { automationsEnablement: true },
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    if (barrier) writeFileSync(join(barrier, 'release'), '')
    writeE2eEnv({ COPSE_E2E_PROJECT_MENU_BARRIER: undefined })
    resetUserData()
    if (root) removeE2eTree(root)
    if (barrier) removeE2eTree(barrier)
  })

  it('opens the requested menu on the replacement row and reaches Automations', async () => {
    const turn = await prepareMockTurn('Check these notes.', [
      { waitFor: 'finish-notes', text: 'The notes are checked.' },
    ])
    await submitComposer()
    await turn.waitForHold('finish-notes')
    const selector = `.project-entry[data-project-id="${PROJECT}"] .project-menu-btn`
    await browser.execute((buttonSelector) => {
      const button = document.querySelector(buttonSelector)
      if (!button) throw new Error('Missing original project menu button')
      button.setAttribute('data-e2e-original-menu', 'true')
    }, selector)
    writeFileSync(join(barrier, 'hold'), '')
    await $(selector).click()
    await browser.waitUntil(() => existsSync(join(barrier, 'started')), { timeout: 10_000 })

    // Finish a real mock-provider turn while the real menu response is held.
    // Its normal status update must replace the original sidebar anchor first.
    await turn.release('finish-notes')
    await turn.waitForComplete()
    await turn.assertComplete()
    await $('[data-e2e-original-menu]').waitForExist({ reverse: true, timeout: 10_000 })
    await expectAssistantReply('The notes are checked.')
    rmSync(join(barrier, 'hold'), { force: true })
    writeFileSync(join(barrier, 'release'), '')

    const menu = $('.context-menu')
    await menu.waitForDisplayed({ timeout: 10_000 })
    const action = menu.$('.context-menu-item=Automations')
    await expect(action).toBeDisplayed()
    await browser.action('pointer').move({ x: 0, y: 0 }).perform()
    await saveAppScreenshot('project-menu-after-updates.png')
    await action.click()
    await $('#automation-dialog').waitForDisplayed()
    assert.match(await $('#automation-dialog .automation-scope').getText(), /Project: Menu notes/)
  })
})
