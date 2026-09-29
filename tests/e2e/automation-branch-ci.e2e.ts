import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-automation-branch-ci'
const DEFINITION_ID = '11111111-1111-4111-8111-111111111111'

describe('branch CI automation editor', function () {
  this.timeout(60_000)

  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, { model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [],
      pluginDisabled: ['copse.automations'],
      pluginMigration: { automationsEnablement: true },
      plugin: {
        copse: {
          automations: {
            'ci-definitions': [
              {
                v: 1,
                id: DEFINITION_ID,
                projectId: PROJECT_ID,
                name: 'Investigate main CI',
                trigger: {
                  kind: 'github-ci-failed',
                  repository: 'github.com/copse-dev/agent-pane',
                  branch: 'main',
                },
                prompt: 'Investigate failed CI.',
                model: 'claude-sonnet-4-6',
                enabled: false,
                maxLiveWorktrees: 1,
                revision: '22222222-2222-4222-8222-222222222222',
                createdAt: 1,
                updatedAt: 1,
                seenDeliveries: [],
              },
            ],
          },
        },
      },
    })
    await browser.reloadSession()
  })
  after(() => {
    resetUserData()
  })

  it('shows a paused branch trigger and the editable CI form', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $(`.project-entry[data-project-id="${PROJECT_ID}"] .project-menu-btn`).click()
    await $('.context-menu-item=Automations').click()
    const dialog = $('#automation-dialog')
    await expect(dialog).toBeDisplayed()
    const row = dialog.$(`[data-ci-automation-id="${DEFINITION_ID}"]`)
    await expect(row).toBeDisplayed()
    await expect(row).toHaveText(expect.stringContaining('github.com/copse-dev/agent-pane · main'))
    await expect(row).toHaveText(expect.stringContaining('Paused'))
    await saveAppScreenshot('automation-branch-ci-list.png')

    await row.$('.automation-row-btn=Edit').click()
    await expect(dialog.$('.automation-ci-form')).toBeDisplayed()
    await expect(dialog.$('.automation-ci-form .automation-when-select')).toHaveValue(
      'github-ci-failed',
    )
    await expect(dialog.$('.automation-ci-form .automation-when-select')).toBeDisabled()
    await expect(dialog.$('.automation-ci-branch')).toHaveValue('main')
    await expect(dialog.$('.automation-ci-summary')).toHaveText(
      expect.stringContaining('One task per run attempt'),
    )
    await saveAppScreenshot('automation-branch-ci-edit.png')

    await dialog.$('.automation-ci-cancel').click()
    await dialog.$('.automation-add-btn').click()
    await expect(dialog.$('.automation-form:not(.automation-ci-form)')).toBeDisplayed()
    await expect(
      dialog.$('.automation-form:not(.automation-ci-form) .automation-when-select'),
    ).toHaveValue('schedule')
    await saveAppScreenshot('automation-trigger-selector.png')
    await dialog
      .$('.automation-form:not(.automation-ci-form) .automation-when-select')
      .selectByAttribute('value', 'github-ci-failed')
    await expect(dialog.$('.automation-ci-form')).toBeDisplayed()
    await expect(dialog.$('.automation-ci-branch')).toHaveValue('')
    await saveAppScreenshot('automation-branch-ci-new.png')
  })
})
