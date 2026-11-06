import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedStableWorkspace, writeSeedConfig } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-host-read-tools-project'
const THREAD_ID = 'e2e-host-read-tools-thread'
const MAIN_SHA = 'abcdef1' + '2'.repeat(33)

function seedHostReadToolCardsFixture(): void {
  const now = Date.now()
  writeSeedConfig({
    projects: [{ id: PROJECT_ID, path: seedStableWorkspace(), name: 'workspace' }],
    activeProjectId: PROJECT_ID,
    expandedProjectId: PROJECT_ID,
    activeThreadId: THREAD_ID,
    [`threads:${PROJECT_ID}`]: [
      {
        id: THREAD_ID,
        title: 'Host read tool cards',
        status: 'idle',
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: [
          {
            id: 'msg-user-host-read',
            role: 'user',
            content: 'Check the branch rules on main, then fetch the PR head so we can diff it.',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-gh-api-read',
            role: 'assistant',
            content: 'Main requires the CI Passed, Screenshot review and CLA checks.',
            toolCalls: [
              {
                id: 'tc-gh-api-read',
                name: 'gh_api_read',
                args: {
                  endpoint: 'repos/{owner}/{repo}/rules/branches/main',
                  jq: '[.[] | .type]',
                },
                status: 'done',
                result: '["required_status_checks","pull_request"]',
              },
            ],
            createdAt: now + 1,
          },
          {
            id: 'msg-assistant-git-fetch',
            role: 'assistant',
            content: 'Fetched the PR head into `origin/pr/42`; local branches are unchanged.',
            toolCalls: [
              {
                id: 'tc-git-fetch',
                name: 'git_fetch',
                args: { refs: ['main', 'refs/pull/42/head'] },
                status: 'done',
                result:
                  'refs/remotes/origin/main 1a2b3c4 (unchanged)\nrefs/remotes/origin/pr/42 5d6e7f8 (new)',
              },
            ],
            createdAt: now + 2,
          },
          {
            id: 'msg-assistant-workflow-runs',
            role: 'assistant',
            content:
              'CI on the main tip is still running. The push-triggered run is pinned to its SHA.',
            toolCalls: [
              {
                id: 'tc-gh-run-list',
                name: 'gh_run_list',
                args: { commit: MAIN_SHA, workflow: 'ci.yml', event: 'push' },
                status: 'done',
                result: `#123 CI: IN_PROGRESS (main @ abcdef1) — CI\n  https://github.com/o/r/actions/runs/123\n  Event: push; SHA: ${MAIN_SHA}`,
              },
            ],
            createdAt: now + 3,
          },
        ],
        createdAt: now,
        updatedAt: now + 3,
      },
    ],
  })
}

describe('host-side read tool cards', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    resetUserData()
    seedHostReadToolCardsFixture()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('labels gh_api_read and git_fetch cards with their own names', async () => {
    const ghCard = $('.tool-card[data-tool-id="tc-gh-api-read"]')
    const fetchCard = $('.tool-card[data-tool-id="tc-git-fetch"]')
    await ghCard.waitForExist({ timeout: 30_000 })
    await fetchCard.waitForExist({ timeout: 30_000 })
    await expect(ghCard.$('.tool-name')).toHaveText('Read GitHub API')
    await expect(fetchCard.$('.tool-name')).toHaveText('Fetched from origin')
    await expect($('.messages-list')).not.toHaveText(expect.stringContaining('gh_api_read'))
    await expect($('.messages-list')).not.toHaveText(expect.stringContaining('git_fetch'))

    await $('.context-wheel.has-breakdown').waitForExist({ timeout: 15_000 })
    await saveAppScreenshot('host-read-tool-cards.png')
  })

  it('shows active status, trigger event and exact commit in expanded workflow evidence', async () => {
    const selector = '.tool-card[data-tool-id="tc-gh-run-list"]'
    const card = $(selector)
    await card.waitForExist({ timeout: 30_000 })
    await expect(card.$('.tool-name')).toHaveText('Listed CI runs')
    await card.scrollIntoView()
    if ((await card.getAttribute('open')) === null) await card.$('summary.tool-card-header').click()
    const result = card.$('.tool-result')
    await expect(result).toBeDisplayed()
    await expect(result).toHaveText(expect.stringContaining('CI: IN_PROGRESS'))
    await expect(result).toHaveText(expect.stringContaining('Event: push'))
    await expect(result).toHaveText(expect.stringContaining(`SHA: ${MAIN_SHA}`))
    await saveElementScreenshot(selector, 'exact-ci-run-evidence.png')
  })
})
