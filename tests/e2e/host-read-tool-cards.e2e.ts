import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-host-read-tools-project'
const THREAD_ID = 'e2e-host-read-tools-thread'

function seedHostReadToolCardsFixture(): void {
  const now = Date.now()
  writeSeedConfig({
    projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
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
        ],
        createdAt: now,
        updatedAt: now + 2,
      },
    ],
  })
}

describe('host-side read tool cards', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
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
})
