import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

// Roadmap editor action buttons stay content-sized (not equal-width grid columns).
describe('roadmap form buttons', () => {
  let workspaceRoot: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-roadmap-buttons-'))
    seedEmptyProject(workspaceRoot, 'e2e-roadmap-buttons', {
      model: 'claude-sonnet-4-6',
      roadmapPlansEnabled: true,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('keeps action buttons compact instead of stretching across the panel', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const roadmapButton = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await roadmapButton.waitForDisplayed({ timeout: 10_000 })
    await roadmapButton.click()
    await $('.roadmap-new-btn').waitForDisplayed({ timeout: 10_000 })
    await $('.roadmap-new-btn').click()
    await expect($('.roadmap-form')).toBeDisplayed()

    const layout = await browser.execute(() => {
      const actions = document.querySelector<HTMLElement>('.roadmap-form .memories-actions')
      const saveBtn = document.querySelector<HTMLElement>('.roadmap-save-btn')
      const startBtn = document.querySelector<HTMLElement>('.roadmap-start-btn')
      if (!actions || !saveBtn || !startBtn) return null
      const actionsStyle = getComputedStyle(actions)
      return {
        actionsDisplay: actionsStyle.display,
        actionsWidth: actions.offsetWidth,
        saveWidth: saveBtn.offsetWidth,
        startWidth: startBtn.offsetWidth,
      }
    })
    assert.ok(layout, 'roadmap form action layout must exist')
    assert.equal(layout.actionsDisplay, 'flex', 'actions use flex, not grid columns')
    assert.ok(
      layout.saveWidth < layout.actionsWidth * 0.5,
      'Save button should not stretch to half the action bar',
    )
    assert.ok(
      layout.startWidth < layout.actionsWidth * 0.5,
      'Start thread button should not stretch to half the action bar',
    )

    await saveAppScreenshot('roadmap-form-buttons.png')
  })
})
