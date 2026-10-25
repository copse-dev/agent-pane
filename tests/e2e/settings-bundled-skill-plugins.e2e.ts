import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { parseSpineLine } from '../../packages/thread-store/src/spine-schema.ts'
import { prepareMockTurn, expectAssistantReply } from './helpers/mock-scenario.ts'
import { submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'

const ENGINEERING_ROW = '.plugin-row[data-plugin-id="copse.engineering"]'

describe('optional pstack and Copse engineering', function () {
  this.timeout(60_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-engineering-plugins')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.execute(() =>
      window.api.settings.set('bundledSkillPluginOverrides', { pstack: true }),
    )
  })

  after(() => {
    resetUserData()
  })

  it('offers an optional install instead of the previously enabled bundled pstack', async () => {
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="customise"]').click()
    const bundled = '.plugin-row[data-plugin-origin="bundled"][data-plugin-id="pstack"]'
    await expect($(bundled)).not.toExist()
    const offer = $('.bundled-plugin-migration')
    await offer.waitForDisplayed({ timeout: 15_000 })
    await expect(offer).toHaveText('pstack is now an optional plugin', { containing: true })
    await saveElementScreenshot('.bundled-plugin-migration', 'settings-pstack-install-offer.png')
    await offer.$('button').click()
    const card = $(
      '.plugin-catalog-card[data-catalog-id="https://github.com/cursor/plugins#pstack"]',
    )
    await card.waitForDisplayed({ timeout: 10_000 })
    await expect(card).toHaveAttribute('data-installed', 'false')
    await expect(card.$('.plugin-catalog-action')).toHaveText('Review install')
    await expect(card.$('.plugin-catalog-badge')).toHaveText('Untested')
    await saveElementScreenshot('#settings-dialog', 'settings-optional-pstack-migration.png')
  })

  it('starts engineering disabled and persists its explicit opt-in', async () => {
    await $('#plugins-installed-tab').click()
    const row = $(ENGINEERING_ROW)
    await row.waitForExist({ timeout: 15_000 })
    await row.scrollIntoView({ block: 'center' })
    await expect(row).toHaveAttribute('data-enabled', 'false')
    await expect(row.$('.plugin-badge-experimental')).toHaveText('Experimental', {
      ignoreCase: true,
    })
    await expect(row.$('.plugin-row-desc')).toHaveText('investigations, changes, and reviews', {
      containing: true,
    })
    await saveElementScreenshot(ENGINEERING_ROW, 'settings-copse-engineering-off.png')
    await row.$('.plugin-toggle').click()
    await browser.waitUntil(
      async () => (await $(ENGINEERING_ROW).getAttribute('data-enabled')) === 'true',
      { timeout: 10_000 },
    )
    await expect($(ENGINEERING_ROW).$('.plugin-toggle-input')).toBeChecked()
    const enabled = await browser.execute(
      async () =>
        (await window.api.plugins.list()).plugins.find(
          (plugin) => plugin.id === 'copse.engineering',
        )?.enabled,
    )
    expect(enabled).toBe(true)
    await $(ENGINEERING_ROW).scrollIntoView({ block: 'center' })
    await saveElementScreenshot(ENGINEERING_ROW, 'settings-copse-engineering-on.png')
    await $(ENGINEERING_ROW).$('.plugin-toggle').click()
    await browser.waitUntil(
      async () => (await $(ENGINEERING_ROW).getAttribute('data-enabled')) === 'false',
      { timeout: 10_000 },
    )
  })

  it('assembles and records the guidance in a native turn after opt-in', async () => {
    await $(ENGINEERING_ROW).$('.plugin-toggle').click()
    await browser.waitUntil(
      async () => (await $(ENGINEERING_ROW).getAttribute('data-enabled')) === 'true',
      { timeout: 10_000 },
    )
    await $('#settings-close').click()
    const scenario = await prepareMockTurn('Explain the parser in this project.', [
      { text: 'The parser converts input into structured records.' },
    ])
    await submitComposer()
    await waitForAgentIdle(30_000)
    await expectAssistantReply('The parser converts input into structured records.')
    await scenario.assertComplete()
    const threadId = await $('.chat-row.selected').getAttribute('data-thread-id')
    assert.ok(threadId)
    const runs = readFileSync(
      join(e2eWorkspaceDir(), 'e2e-engineering-plugins', threadId, 'events.jsonl'),
      'utf8',
    )
      .split('\n')
      .map(parseSpineLine)
    const run = runs.find(
      (line) => line?.type === 'hook_run' && line.hookId === 'engineering-workflows',
    )
    assert.ok(run?.type === 'hook_run')
    const detail = await browser.execute(
      ({ threadId, runId }) =>
        window.api.hooks.runDetail('e2e-engineering-plugins', threadId, runId),
      { threadId, runId: run.id },
    )
    assert.match(detail.outcome ?? '', /Copse engineering workflows/)
    assert.match(detail.outcome ?? '', /Investigate:.*Change:.*Review:/s)
  })
})
