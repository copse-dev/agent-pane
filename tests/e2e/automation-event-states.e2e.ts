import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSeedConfig,
} from './helpers/seed-config.ts'

// Visual evidence for the event-automation editor states and the unattended-run failure states
// (docs/plans/event-driven-automations.md, docs/plans/automations.md#failure-states).
//
// Electron rather than the browser tier because the manager reads real stored definitions and
// the delivery history crosses real IPC. The deliveries themselves are covered by unit tests: a
// receipt is keyed by a digest of its evidence, so it is not seeded from here.
//
// The cause of each failure is seeded through the fields main and the renderer actually write
// (`lastProblem`, `automation.failure`), not through a test-only path.

const PROJECT_ID = 'e2e-automation-event-states'
const PROJECT_MENU = `.project-entry[data-project-id="${PROJECT_ID}"] .project-menu-btn`
const SEEDED_AT = 1_786_000_000_000
// Thread ages are relative; definition error timestamps below remain absolute and fixed.
const RUN_AT = Date.now() - 62.5 * 24 * 60 * 60 * 1_000
const PR_ID = '11111111-1111-4111-8111-111111111111'
const ISSUE_ID = '33333333-3333-4333-8333-333333333333'
const CI_ID = '44444444-4444-4444-8444-444444444444'
const FAILED_RUN = 'e2e-event-failed-run'
const OPEN_THREAD = 'e2e-event-open-thread'

function definition(id: string, name: string, trigger: object, extra: object = {}): object {
  return {
    v: 1,
    id,
    projectId: PROJECT_ID,
    name,
    trigger,
    prompt: 'Look at it.',
    model: 'claude-sonnet-4-6',
    enabled: true,
    maxLiveWorktrees: 1,
    revision: '22222222-2222-4222-8222-222222222222',
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

describe('event automation states', function () {
  this.timeout(120_000)

  before(async () => {
    resetUserData()
    const workspace = seedStableWorkspace()
    seedEmptyProject(workspace, PROJECT_ID, { model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: workspace, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      // Another thread is open, so the failed run is not read the moment the app starts.
      activeThreadId: OPEN_THREAD,
      [`threads:${PROJECT_ID}`]: [
        {
          id: OPEN_THREAD,
          title: 'Open thread',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: RUN_AT - 10,
          updatedAt: RUN_AT - 10,
        },
        {
          id: FAILED_RUN,
          title: 'Review pull requests',
          status: 'error',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          model: 'claude-sonnet-4-6',
          automation: {
            scheduleId: PR_ID,
            scheduleName: 'Review pull requests',
            triggeredAt: RUN_AT,
            failure: {
              code: 'auth-expired',
              message: '401 Unauthorized: the API key was rejected.',
              at: RUN_AT + 5_000,
            },
          },
          createdAt: RUN_AT,
          updatedAt: RUN_AT + 5_000,
          unreadAt: RUN_AT + 5_000,
        },
      ],
      pluginDisabled: [],
      pluginMigration: { automationsEnablement: true },
      plugin: {
        copse: {
          automations: {
            'ci-definitions': [
              definition(
                PR_ID,
                'Review pull requests',
                {
                  kind: 'github-pr-changed',
                  repository: 'github.com/copse-dev/agent-pane',
                  baseBranch: 'main',
                  transition: 'ready-for-review',
                },
                {
                  lastCreatedThreadId: FAILED_RUN,
                  lastProblem: {
                    at: SEEDED_AT + 6_000,
                    kind: 'failed',
                    code: 'worktree-failed',
                    message: 'Isolated worktree is unavailable: submodules unsupported',
                    threadId: FAILED_RUN,
                  },
                },
              ),
              definition(
                ISSUE_ID,
                'Triage new issues',
                {
                  kind: 'github-issue-labeled',
                  repository: 'github.com/copse-dev/agent-pane',
                  label: 'needs-triage',
                },
                {
                  // Paused, so the poller does not replace the seeded problem with a real
                  // one from this sandbox's GitHub access.
                  enabled: false,
                  lastProblem: {
                    at: SEEDED_AT + 7_000,
                    kind: 'failed',
                    code: 'unknown',
                    message: 'Could not read GitHub: API rate limit exceeded',
                  },
                },
              ),
              definition(
                CI_ID,
                'Investigate CI on #42',
                {
                  kind: 'github-ci-failed',
                  repository: 'github.com/copse-dev/agent-pane',
                  branch: 'feature-42',
                  pullRequest: 42,
                  checks: ['CI', 'Lint'],
                },
                {
                  enabled: false,
                  lastProblem: {
                    at: SEEDED_AT + 8_000,
                    kind: 'failed',
                    code: 'no-model',
                    message: 'The model gpt-retired was not found.',
                  },
                },
              ),
            ],
          },
        },
      },
    })
    await browser.reloadSession()
  })

  afterEach(async () => {
    // A failed assertion must not leave the modal over the next test's controls.
    const close = $('#automation-dialog[open] [aria-label="Close automations"]')
    if (await close.isExisting()) await close.click()
  })

  after(() => {
    resetUserData()
  })

  it('lists each trigger kind with its filters and names why a run failed, with the next step', async () => {
    const dialog = await openManager()
    const pr = dialog.$(`[data-ci-automation-id="${PR_ID}"]`)
    const issue = dialog.$(`[data-ci-automation-id="${ISSUE_ID}"]`)
    const ci = dialog.$(`[data-ci-automation-id="${CI_ID}"]`)
    await expect(pr).toHaveText(expect.stringContaining('PR ready for review'))
    await expect(issue).toHaveText(expect.stringContaining('Issue labelled'))
    await expect(issue).toHaveText(expect.stringContaining('needs-triage'))
    await expect(ci).toHaveText(expect.stringContaining('PR #42'))
    await expect(ci).toHaveText(expect.stringContaining('CI, Lint'))

    await expect(pr.$('.automation-problem-title')).toHaveText('Checkout could not be prepared')
    await expect(pr.$('.automation-problem-remedy')).toHaveText(
      expect.stringContaining('prompt is kept as a draft'),
    )
    await expect(pr.$('.automation-problem-action')).toHaveText('Open run')
    await expect(ci.$('.automation-problem-title')).toHaveText('Model unavailable')
    await expect(ci.$('.automation-problem-action')).toHaveText('Edit automation')
    await expect(issue.$('.automation-problem-title')).toHaveText('Could not check GitHub')
    await expect(issue.$('.automation-problem-message')).toHaveText(
      expect.stringContaining('rate limit'),
    )

    await issue.$('.automation-deliveries > summary').click()
    await expect(issue.$('.automation-deliveries-body')).toHaveText(
      expect.stringContaining('No deliveries yet.'),
    )
    await saveAppScreenshot('automation-event-error-states.png')
  })

  it('edits a pull-request trigger and an issue-label trigger, and a CI trigger with filters', async () => {
    const dialog = await openManager()
    const form = dialog.$('.automation-ci-form')

    await dialog.$(`[data-ci-automation-id="${PR_ID}"]`).$('.automation-row-btn=Edit').click()
    await expect(form).toBeDisplayed()
    await expect(form.$('.automation-pr-base')).toHaveValue('main')
    await expect(form.$('.automation-pr-transition')).toHaveValue('ready-for-review')
    await expect(form.$('.automation-ci-branch')).not.toBeDisplayed()
    await expect(form.$('.automation-ci-summary')).toHaveText(
      expect.stringContaining('becomes ready for review'),
    )
    await saveAppScreenshot('automation-event-editor-pull-request.png')
    await dialog.$('.automation-ci-cancel').click()

    await dialog.$(`[data-ci-automation-id="${ISSUE_ID}"]`).$('.automation-row-btn=Edit').click()
    await expect(form.$('.automation-issue-label')).toHaveValue('needs-triage')
    await expect(form.$('.automation-pr-base')).not.toBeDisplayed()
    await expect(form.$('.automation-ci-summary')).toHaveText(
      expect.stringContaining('needs-triage'),
    )
    await saveAppScreenshot('automation-event-editor-issue-label.png')
    await dialog.$('.automation-ci-cancel').click()

    await dialog.$(`[data-ci-automation-id="${CI_ID}"]`).$('.automation-row-btn=Edit').click()
    await expect(form.$('.automation-ci-pull-request')).toHaveValue('42')
    await expect(form.$('.automation-ci-checks')).toHaveValue('CI, Lint')
    await expect(form.$('.automation-ci-summary')).toHaveText(
      expect.stringContaining('pull request #42 (only CI, Lint)'),
    )
    await saveAppScreenshot('automation-event-editor-ci-filters.png')
  })

  it('keeps event automation sidebar rows current after editing and deleting', async () => {
    const dialog = await openManager()
    await dialog.$(`[data-ci-automation-id="${ISSUE_ID}"]`).$('.automation-row-btn=Edit').click()
    await dialog.$('.automation-ci-name').setValue('Triage updated issues')
    await dialog.$('.automation-ci-form button[type="submit"]').click()
    await browser.waitUntil(
      async () => {
        const status = await dialog.$('.automation-status').getText()
        if (status) throw new Error(status)
        return !(await dialog.$('.automation-ci-form').isDisplayed())
      },
      { timeout: 10_000 },
    )
    await dialog.$('[aria-label="Close automations"]').click()
    const toggle = $('.automation-threads-toggle')
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    const row = $(
      '//*[contains(@class, "is-automation-unrun") and contains(., "Triage updated issues")]',
    )
    await expect(row).toBeDisplayed()
    await row.click({ button: 'right' })
    await expect($('.context-menu-item=Automation setup…')).toBeDisplayed()
    await expect($('.context-menu-item=Run now')).not.toExist()
    await saveAppScreenshot('automation-event-unrun-menu.png')
    await browser.keys('Escape')
    await row.click()
    await dialog.$('.automation-ci-cancel').click()
    await dialog.$(`[data-ci-automation-id="${ISSUE_ID}"]`).$('.automation-row-btn=Delete').click()
    await $('#confirm-dialog .confirm-dialog-confirm').click()
    await dialog.$(`[data-ci-automation-id="${ISSUE_ID}"]`).waitForExist({ reverse: true })
    await dialog.$('[aria-label="Close automations"]').click()
    await expect(
      $('//*[contains(@class, "is-automation-unrun") and contains(., "Triage updated issues")]'),
    ).not.toExist()
    await saveAppScreenshot('automation-event-unrun-deleted.png')
  })

  it('shows a failed unattended run in Activity with its cause and remedy', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.prompt-input').click()
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'Shift', 'a'])
    await $('#activity-panel').waitForDisplayed({ timeout: 10_000 })
    const row = $(`#activity-panel .activity-row[data-thread-id="${FAILED_RUN}"]`)
    await expect(row).toBeDisplayed()
    await expect(row.$('.activity-issue')).toHaveText('Sign-in expired')
    await row.$('[data-control="open"]').click()
    const detail = $('#activity-panel .activity-issue-detail')
    await expect(detail).toBeDisplayed()
    assert.match(await detail.getText(), /API key was rejected/)
    assert.match(await detail.getText(), /Sign in again or replace the API key/)
    await saveAppScreenshot('automation-event-activity-failed-run.png')
  })
})
