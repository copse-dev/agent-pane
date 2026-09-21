import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  readSeededSettings,
  resetUserData,
  seedEmptyProject,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { waitForAgentIdle, waitForPromptReady } from './helpers.ts'
import { startConversationServer, type ConversationServer } from './helpers/conversation-server.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-worktree-branch-title-project'
const THREAD_ID = 'e2e-worktree-branch-title-abc123'
const TITLED_BRANCH = 'copse/auth-session-repair-abc123'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('automatic worktree branch naming', () => {
  let projectRoot = ''
  let worktreeRoot = ''
  let server: ConversationServer

  before(async function () {
    this.timeout(120_000)
    server = await startConversationServer({ title: 'Auth Session Repair' })
    // Assert the actual renamed Git branch rather than the screenshot harness's fixed branch.
    server.configureEnvironment({ COPSE_PANEL_MOCK_BRANCH: '' })
    resetUserData()
    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    projectRoot = mkdtempSync(join(tmpdir(), 'copse-branch-title-'))
    worktreeRoot = join(worktreesRoot, PROJECT_ID, THREAD_ID)
    rmSync(worktreeRoot, { recursive: true, force: true })
    git(projectRoot, ['init', '-q', '-b', 'main'])
    git(projectRoot, ['config', 'user.email', 'e2e@example.invalid'])
    git(projectRoot, ['config', 'user.name', 'Copse E2E'])
    git(projectRoot, ['config', 'init.defaultBranch', 'main'])
    writeFileSync(join(projectRoot, 'README.md'), 'branch title fixture\n')
    git(projectRoot, ['add', 'README.md'])
    git(projectRoot, ['commit', '-qm', 'seed'])

    seedEmptyProject(projectRoot, PROJECT_ID, {
      subagentsEnabled: false,
      nextStepSuggestionEnabled: false,
    })
    writeSettings({ ...readSeededSettings(), ...server.settings })
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: projectRoot, name: 'workspace', worktreeMode: 'always' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'New Thread',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(async () => {
    resetUserData()
    if (worktreeRoot) rmSync(worktreeRoot, { recursive: true, force: true })
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
    await server.close()
  })

  it('starts anonymous and adopts the first generated title after the turn', async function () {
    this.timeout(120_000)
    await waitForPromptReady()
    const prompt = 'Repair the authentication session flow.'
    server.enqueue({ user: prompt, text: 'The repair is ready.' })
    await setComposerValue(prompt)
    await $('.submit-btn').click()
    await waitForAgentIdle()

    const branchLabel = $('.footer-branch-status .footer-branch-label')
    await expect(branchLabel).toHaveText(TITLED_BRANCH, { wait: 30_000 })
    await expect($('.chat-row.selected .chat-title')).toHaveText('Auth Session Repair')
    assert.equal(git(worktreeRoot, ['branch', '--show-current']), TITLED_BRANCH)
    server.assertTitleRequested(prompt)
    server.assertComplete()
    await saveAppScreenshot('thread-worktree-branch-auto-named.png')
  })
})
