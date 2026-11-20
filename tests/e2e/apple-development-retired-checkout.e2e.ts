import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { copseDataRoot } from '../../src/main/services/storage/copse-paths.ts'
import { e2eWorkspaceDir, resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { parkPointer, saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { E2E_GIT_BRANCH, writeE2eEnv } from './helpers/e2e-env.ts'

describe('Viewing and resuming a handed-over automation run', function () {
  this.timeout(60_000)
  const projectId = 'e2e-retired-apple-project'
  const threadId = 'old-run'
  const branch = 'copse/automation-run'
  let root: string
  let checkout: string
  let oldCheckout: string
  let head: string

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Copse Test',
        GIT_AUTHOR_EMAIL: 'copse@example.invalid',
        GIT_COMMITTER_NAME: 'Copse Test',
        GIT_COMMITTER_EMAIL: 'copse@example.invalid',
      },
    }).trim()

  before(async () => {
    resetUserData()
    root = mkdtempSync(join(tmpdir(), 'copse-retired-apple-'))
    git(root, ['init', '-q', '-b', 'main'])
    writeFileSync(join(root, 'README.md'), 'Automation project\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'base'])
    head = git(root, ['rev-parse', 'HEAD'])
    const managedRoot = join(copseDataRoot(), 'worktrees', projectId)
    mkdirSync(managedRoot, { recursive: true })
    checkout = join(managedRoot, 'new-run')
    oldCheckout = join(managedRoot, threadId)
    git(root, ['worktree', 'add', '-b', branch, checkout])
    writeFileSync(join(checkout, 'pending.txt'), 'Newer run work\n')
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: projectId, path: root, name: 'Automation project' }],
      activeProjectId: projectId,
      expandedProjectId: projectId,
      activeThreadId: 'new-run',
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Finished automation run',
          status: 'idle',
          messages: [
            {
              id: 'finished',
              role: 'assistant',
              content: 'The investigation is complete.',
              toolCalls: [],
              createdAt: now,
            },
          ],
          todos: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
          worktree: {
            path: oldCheckout,
            branch,
            baseBranch: 'main',
            baseCommit: head,
            createdAt: now,
            seededFromDirtyProject: false,
            retiredAt: now,
            retiredHead: head,
          },
        },
        {
          id: 'new-run',
          title: 'Newer automation run',
          status: 'idle',
          messages: [],
          todos: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now + 1,
          updatedAt: now + 1,
          worktree: {
            path: checkout,
            branch,
            baseBranch: 'main',
            baseCommit: head,
            createdAt: now + 1,
            seededFromDirtyProject: false,
          },
        },
      ],
    })
    writeE2eEnv({ COPSE_PANEL_MOCK_BRANCH: '' })
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({ COPSE_PANEL_MOCK_BRANCH: E2E_GIT_BRANCH })
    resetUserData()
    removeE2eTree(root)
    removeE2eTree(join(copseDataRoot(), 'worktrees', projectId))
  })

  it('keeps history reads retired, then prepares a resumed turn without disturbing the newer run', async () => {
    await expect($('.prompt-input')).toBeDisplayed()
    const state = await browser.execute(
      (project, thread) => window.api.appleDevelopment.state(project, thread),
      projectId,
      threadId,
    )
    assert.equal(state.enrolled, false)
    const beforeOpen = git(root, ['worktree', 'list', '--porcelain'])
    assert.ok(!beforeOpen.includes(oldCheckout), beforeOpen)
    const threadRoot = join(e2eWorkspaceDir(), projectId, threadId)
    const beforeMeta = readFileSync(join(threadRoot, 'meta.json'), 'utf8')
    const beforeSpine = readFileSync(join(threadRoot, 'events.jsonl'), 'utf8')
    const retiredBefore = await browser.execute(
      async (project, thread) =>
        (await window.api.threads.loadProject(project)).find((run) => run.id === thread)?.worktree,
      projectId,
      threadId,
    )
    assert.ok(retiredBefore?.retiredAt)
    await $('.chat-row[data-thread-id="old-run"]').click()
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('The investigation is complete.'),
    )
    // History and passive Git inspection must leave cleanup durable. The
    // existing submit preparation below deliberately resumes this checkout.
    const passiveBranch = await browser.execute(
      (project, thread) => window.api.git.currentBranch(project, thread),
      projectId,
      threadId,
    )
    assert.equal(passiveBranch, null)
    assert.equal(existsSync(oldCheckout), false)
    const retiredAfterBrowse = await browser.execute(
      async (project, thread) =>
        (await window.api.threads.loadProject(project)).find((run) => run.id === thread)?.worktree,
      projectId,
      threadId,
    )
    assert.equal(retiredAfterBrowse?.retiredAt, retiredBefore.retiredAt)
    const afterBrowseMeta = readFileSync(join(threadRoot, 'meta.json'), 'utf8')
    assert.equal(readFileSync(join(threadRoot, 'events.jsonl'), 'utf8'), beforeSpine)
    assert.equal(git(checkout, ['branch', '--show-current']), branch)
    assert.equal(git(checkout, ['rev-parse', 'HEAD']), head)
    assert.equal(readFileSync(join(checkout, 'pending.txt'), 'utf-8'), 'Newer run work\n')
    await expect($('.apple-development-error')).not.toExist()

    const resumePromptState = await browser.execute(
      (project, thread) => window.api.git.promptState(project, thread),
      projectId,
      threadId,
    )
    assert.deepEqual(resumePromptState, { startingCommit: head, dirty: false })
    const restoredBranch = await browser.execute(
      (project, thread) => window.api.git.currentBranch(project, thread),
      projectId,
      threadId,
    )
    assert.ok(restoredBranch)
    assert.notEqual(restoredBranch, branch)
    assert.equal(git(oldCheckout, ['branch', '--show-current']), restoredBranch)
    assert.equal(git(oldCheckout, ['rev-parse', 'HEAD']), head)
    await expect($('.apple-development-error')).not.toExist()
    assert.equal(git(checkout, ['branch', '--show-current']), branch)
    assert.equal(git(checkout, ['rev-parse', 'HEAD']), head)
    assert.equal(readFileSync(join(checkout, 'pending.txt'), 'utf-8'), 'Newer run work\n')
    assert.equal(readFileSync(join(threadRoot, 'events.jsonl'), 'utf8'), beforeSpine)
    const artifacts = join(process.cwd(), '.tmp', 'apple-explicit-restore-native-artifacts')
    mkdirSync(artifacts, { recursive: true })
    const proof = {
      oldCheckout,
      checkout,
      branch,
      head,
      passiveBranch,
      resumePromptState,
      restoredBranch,
      restoredGitBranch: git(oldCheckout, ['branch', '--show-current']),
      restoredHead: git(oldCheckout, ['rev-parse', 'HEAD']),
      retiredBefore,
      retiredAfterBrowse,
      beforeMeta,
      afterBrowseMeta,
      restoredMeta: readFileSync(join(threadRoot, 'meta.json'), 'utf8'),
      beforeSpine,
      restoredSpine: readFileSync(join(threadRoot, 'events.jsonl'), 'utf8'),
      newerBranch: git(checkout, ['branch', '--show-current']),
      newerHead: git(checkout, ['rev-parse', 'HEAD']),
      newerPending: readFileSync(join(checkout, 'pending.txt'), 'utf8'),
    }
    writeFileSync(
      join(artifacts, 'receipt.json'),
      JSON.stringify({ ...proof, phase: 'prepared' }, null, 2),
    )
    // Render the durable checkout state in a normal fresh session. The empty
    // newer thread is only a Git collision holder, not a navigation fixture.
    await browser.reloadSession()
    await $('.prompt-input').waitForDisplayed({ timeout: 30_000 })
    await $('.chat-row[data-thread-id="old-run"]').click()
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('The investigation is complete.'),
    )
    await expect($('.footer-branch-label')).toHaveText(expect.stringContaining(restoredBranch))
    await expect($('.apple-development-error')).not.toExist()
    assert.equal(git(oldCheckout, ['branch', '--show-current']), restoredBranch)
    assert.equal(git(oldCheckout, ['rev-parse', 'HEAD']), head)
    assert.equal(git(checkout, ['branch', '--show-current']), branch)
    assert.equal(git(checkout, ['rev-parse', 'HEAD']), head)
    assert.equal(readFileSync(join(checkout, 'pending.txt'), 'utf8'), 'Newer run work\n')
    assert.equal(readFileSync(join(threadRoot, 'events.jsonl'), 'utf8'), beforeSpine)
    writeFileSync(
      join(artifacts, 'receipt.json'),
      JSON.stringify(
        {
          ...proof,
          phase: 'displayed',
          reloadedMeta: readFileSync(join(threadRoot, 'meta.json'), 'utf8'),
          reloadedSpine: readFileSync(join(threadRoot, 'events.jsonl'), 'utf8'),
        },
        null,
        2,
      ),
    )
    await parkPointer()
    await saveAppScreenshot('apple-development-handed-over-run.png')
  })
})
