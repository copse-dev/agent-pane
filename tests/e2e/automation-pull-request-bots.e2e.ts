import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSeedConfig,
} from './helpers/seed-config.ts'

// Visual evidence for the pull request bot triggers: CI failing on any open pull request and
// new review comments (docs/plans/event-driven-automations.md#status-update-2026-11-25-pull-request-bots).
//
// Electron because the manager reads real stored definitions across IPC. Both definitions are
// seeded paused so the poller never reaches GitHub from the test machine; polling, batching and
// limits are covered by event-triggers.test.ts.

const PROJECT_ID = 'e2e-automation-pull-request-bots'
const PROJECT_MENU = `.project-entry[data-project-id="${PROJECT_ID}"] .project-menu-btn`
const SEEDED_AT = 1_786_000_000_000
const CI_ID = '55555555-5555-4555-8555-555555555555'
const REVIEW_ID = '66666666-6666-4666-8666-666666666666'

function definition(id: string, name: string, trigger: object, extra: object = {}): object {
  return {
    v: 1,
    id,
    projectId: PROJECT_ID,
    name,
    trigger,
    prompt: 'Check out the pull request branch, fix it, and push.',
    model: 'claude-sonnet-4-6',
    enabled: false,
    maxLiveWorktrees: 1,
    revision: '77777777-7777-4777-8777-777777777777',
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    seenDeliveries: [],
    ...extra,
  }
}

async function openManager(): Promise<ReturnType<typeof $>> {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await $(PROJECT_MENU).click()
  await $('.context-menu-item=Automations').click()
  const dialog = $('#automation-dialog')
  await expect(dialog).toBeDisplayed()
  return dialog
}

describe('pull request bot automations', function () {
  this.timeout(120_000)

  before(async () => {
    resetUserData()
    const workspace = seedStableWorkspace()
    seedEmptyProject(workspace, PROJECT_ID, { model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: workspace, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      pluginDisabled: [],
      pluginMigration: { automationsEnablement: true },
      plugin: {
        copse: {
          automations: {
            'ci-definitions': [
              definition(CI_ID, 'Fix failing CI on my PRs', {
                kind: 'github-pr-ci-failed',
                repository: 'github.com/copse-dev/agent-pane',
                baseBranch: 'main',
                authors: 'mine',
                viewer: 'octocat',
                checks: ['CI'],
              }),
              definition(
                REVIEW_ID,
                'Address review comments',
                {
                  kind: 'github-pr-review-comment',
                  repository: 'github.com/copse-dev/agent-pane',
                  baseBranch: 'main',
                  authors: 'mine',
                  viewer: 'octocat',
                  commenters: 'collaborators',
                },
                { commentCursor: { review: 100, conversation: 200 } },
              ),
            ],
          },
        },
      },
    })
    await browser.reloadSession()
  })

  afterEach(async () => {
    const close = $('#automation-dialog[open] [aria-label="Close automations"]')
    if (await close.isExisting()) await close.click()
  })

  after(() => {
    resetUserData()
  })

  it('lists both bots with whose pull requests they watch', async () => {
    const dialog = await openManager()
    const ci = dialog.$(`[data-ci-automation-id="${CI_ID}"]`)
    const review = dialog.$(`[data-ci-automation-id="${REVIEW_ID}"]`)
    await expect(ci).toHaveText(expect.stringContaining('Failed PR CI'))
    await expect(ci).toHaveText(expect.stringContaining('PRs by octocat into main'))
    await expect(ci).toHaveText(expect.stringContaining('CI'))
    await expect(review).toHaveText(expect.stringContaining('PR review comments'))
    await saveAppScreenshot('automation-pull-request-bots-list.png')
  })

  it('edits the CI bot and the review comment bot with their own fields', async () => {
    const dialog = await openManager()
    const form = dialog.$('.automation-ci-form')

    await dialog.$(`[data-ci-automation-id="${CI_ID}"]`).$('.automation-row-btn=Edit').click()
    await expect(form).toBeDisplayed()
    await expect(form.$('.automation-pr-base')).toHaveValue('main')
    await expect(form.$('.automation-pr-authors')).toHaveValue('mine')
    await expect(form.$('.automation-ci-checks')).toHaveValue('CI')
    await expect(form.$('.automation-ci-branch')).not.toBeDisplayed()
    await expect(form.$('.automation-pr-commenters')).not.toBeDisplayed()
    await expect(form.$('.automation-ci-summary')).toHaveText(
      expect.stringContaining('one of my pull requests into main'),
    )
    await saveAppScreenshot('automation-pull-request-bots-ci-editor.png')
    await dialog.$('.automation-ci-cancel').click()

    await dialog.$(`[data-ci-automation-id="${REVIEW_ID}"]`).$('.automation-row-btn=Edit').click()
    await expect(form.$('.automation-pr-commenters')).toHaveValue('collaborators')
    await expect(form.$('.automation-ci-checks')).not.toBeDisplayed()
    await expect(form.$('.automation-ci-summary')).toHaveText(
      expect.stringContaining('replies a run posts as me, are ignored'),
    )
    await saveAppScreenshot('automation-pull-request-bots-review-editor.png')
  })
})
