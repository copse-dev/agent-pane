import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-automation-dialog'
const OTHER_PROJECT_ID = 'e2e-automation-other-project'
const PROJECT_MENU = `.project-entry[data-project-id="${PROJECT_ID}"] .project-menu-btn`

describe('automation modal from the project row menu', function () {
  this.timeout(60_000)

  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, { model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [
        { id: PROJECT_ID, path: process.cwd(), name: 'workspace' },
        { id: OTHER_PROJECT_ID, path: process.cwd(), name: 'other-project' },
      ],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [],
      pluginDisabled: ['copse.automations'],
      pluginMigration: { automationsEnablement: true },
    })
    await browser.reloadSession()
  })
  after(() => {
    resetUserData()
  })

  it('creates and edits the same saved automation in the modal and Settings', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await expect($('.projects-settings-actions .project-menu-btn')).not.toExist()
    await expect($('.projects-menu-btn')).not.toExist()
    await $(PROJECT_MENU).click()
    await expect($('.context-menu-item=Automations')).toBeDisplayed()
    await saveAppScreenshot('automation-project-menu.png')
    // An OS focus change dismisses menus. Capturing should not make the next
    // action depend on whether another native window became active meanwhile.
    if (!(await $('.context-menu-item=New automation…').isExisting())) {
      await $(PROJECT_MENU).click()
    }
    await $('.context-menu-item=New automation…').click()
    const dialog = $('#automation-dialog')
    await expect(dialog).toBeDisplayed()
    await expect($('#settings-dialog')).not.toBeDisplayed()
    await expect(dialog.$('.automation-form')).toBeDisplayed()
    await dialog.$('.automation-name-input').setValue('Weekday project review')
    await dialog
      .$('.automation-prompt-input')
      .setValue('Review open work and report the next useful action.')
    // Enablement is plugin-wide. It must not replace the draft editor.
    await dialog.$('.automation-plugin-toggle').click()
    await expect(dialog.$('.automation-plugin-toggle')).toHaveText('Disable plugin')
    await expect(dialog.$('.automation-name-input')).toHaveValue('Weekday project review')
    await dialog.$('.automation-enabled-input').click()
    await saveAppScreenshot('automation-create-modal.png')
    await dialog.$('.automation-save-btn').click()
    await expect(dialog.$('.automation-row-title')).toHaveText('Weekday project review')
    await expect(dialog.$('.automation-form')).not.toBeDisplayed()
    await saveAppScreenshot('automation-manager-modal.png')

    await dialog.$('[aria-label="Close automations"]').click()
    await $('[aria-label="Settings"]').click()
    const settings = $('#settings-dialog')
    await settings.$('[data-section="customise"]').click()
    const plugin = settings.$('.plugin-row[data-plugin-id="copse.automations"]')
    await plugin.scrollIntoView({ block: 'center' })
    await plugin.$('.plugin-settings-summary').click()
    await expect(plugin.$('.automation-row-title')).toHaveText('Weekday project review')
    await plugin.$('.automation-row-btn=Edit').click()
    await expect(plugin.$('.automation-name-input')).toHaveValue('Weekday project review')
    await settings.$('#settings-close').click()

    await $(PROJECT_MENU).click()
    await $('.context-menu-item=Automations').click()
    await expect(dialog).toBeDisplayed()
    await dialog.$('.automation-row-btn=Edit').click()
    await expect(dialog.$('.automation-form')).toBeDisplayed()
    const bounds = await browser.execute(() => {
      const element = document.querySelector('#automation-dialog')
      if (!element) throw new Error('Missing modal')
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: window.innerWidth,
        height: window.innerHeight,
      }
    })
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width)
    assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height)
    await browser.keys('Escape')
    await expect(dialog).not.toBeDisplayed()
  })

  it('opens the collapsed project’s automation editor from its own row', async () => {
    const other = $(`.project-entry[data-project-id="${OTHER_PROJECT_ID}"]`)
    await expect(other.$('.project-row')).not.toHaveElementClass('active')
    await other.$('.project-menu-btn').click()
    await $('.context-menu-item=New automation…').click()
    const dialog = $('#automation-dialog')
    await expect(dialog).toBeDisplayed()
    await expect(dialog.$('.automation-scope')).toHaveText(
      expect.stringContaining('Project: other-project'),
    )
    await expect(dialog.$('.automation-form')).toBeDisplayed()
    await expect(other.$('.project-row')).not.toHaveElementClass('active')
    await saveAppScreenshot('automation-project-menu-inactive.png')
    await dialog.$('[aria-label="Close automations"]').click()
  })
})
