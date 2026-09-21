import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedGitChangesFixture,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-git-changes-project'

describe('Changes pane thread retention', function () {
  this.timeout(120_000)
  let repoRoot = ''

  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    repoRoot = seedGitChangesFixture()
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: repoRoot, name: 'Git retention' }],
      activeProjectId: PROJECT_ID,
      expandedProjectId: PROJECT_ID,
      activeThreadId: 'e2e-git-changes-thread',
      [`threads:${PROJECT_ID}`]: ['a', 'b'].map((suffix) => ({
        id: suffix === 'a' ? 'e2e-git-changes-thread' : 'retention-b',
        title: `Review ${suffix.toUpperCase()}`,
        status: 'idle',
        messages: [
          {
            id: `message-${suffix}`,
            role: 'user',
            content: `Review ${suffix.toUpperCase()}`,
            toolCalls: [],
            createdAt: now,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        updatedAt: now,
      })),
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
    if (repoRoot) cleanupGitChangesFixture(repoRoot)
  })

  it('restores each thread selection and continues receiving real working-tree changes', async () => {
    await $('.titlebar-btn[aria-label="Open changes"]').click()
    await $('.git-change-row*=unstaged.ts').waitForDisplayed({ timeout: 30_000 })
    await $('.git-change-row*=unstaged.ts').click()
    await expect($('.git-change-row.is-selected .git-change-path')).toHaveText('unstaged.ts')
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 30_000 })

    await $('.chat-title=Review B').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('Review B')
    await expect($('.git-change-row.is-selected .git-change-path')).toHaveText('staged.ts')

    await $('.chat-title=Review A').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('Review A')
    await expect($('.git-change-row.is-selected .git-change-path')).toHaveText('unstaged.ts')
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 30_000 })

    writeFileSync(join(repoRoot, 'retention-external.ts'), 'export const stillWatching = true\n')
    await browser.waitUntil(
      async () =>
        (await $$('.git-change-path').map((element) => element.getText())).includes(
          'retention-external.ts',
        ),
      { timeout: 15_000, timeoutMsg: 'working-tree updates should still refresh cached rows' },
    )
    await expect($('.git-change-row.is-selected .git-change-path')).toHaveText('unstaged.ts')
    await saveAppScreenshot('git-changes-thread-retention.png')
  })
})
