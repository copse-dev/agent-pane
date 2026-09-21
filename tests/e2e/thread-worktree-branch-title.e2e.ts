import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { waitForAgentIdle, waitForPromptReady } from './helpers.ts'
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

  beforeEach(() => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
  })

  before(async function () {
    this.timeout(120_000)
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
      model: 'claude-sonnet-4-6',
      smallTasksModel: 'claude-sonnet-4-6',
      subagentsEnabled: false,
      nextStepSuggestionEnabled: false,
    })
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

  after(() => {
    resetUserData()
    if (worktreeRoot) rmSync(worktreeRoot, { recursive: true, force: true })
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
    delete process.env['COPSE_PANEL_MOCK_LLM']
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['OPENAI_API_KEY']
  })

  it('starts anonymous and adopts the first generated title after the turn', async function () {
    this.timeout(120_000)
    await waitForPromptReady()
    await browser.execute(async () => {
      const bridge = (
        window as unknown as {
          __copseE2e: { setMockScript: (script: unknown) => Promise<unknown> }
        }
      ).__copseE2e
      await bridge.setMockScript([
        { when: 'Repair the authentication session flow', text: 'The repair is ready.' },
        { when: 'Reply with ONLY a concise 3-5 word title', text: 'Auth Session Repair' },
      ])
    })

    await setComposerValue('Repair the authentication session flow.')
    await $('.submit-btn').click()
    await waitForAgentIdle()

    const branchLabel = $('.footer-branch-status .footer-branch-label')
    await expect(branchLabel).toHaveText(TITLED_BRANCH, { wait: 30_000 })
    await expect($('.chat-row.selected .chat-title')).toHaveText('Auth Session Repair')
    assert.equal(git(worktreeRoot, ['branch', '--show-current']), TITLED_BRANCH)
    await saveAppScreenshot('thread-worktree-branch-auto-named.png')
  })
})
