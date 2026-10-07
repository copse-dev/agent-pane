import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig, writeSettings } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { e2eWorkspaceDir } from './helpers/seed-config.ts'
import type { Thread } from '../../src/shared/types/index.ts'

const projectId = 'e2e-changes-project'
const threadId = 'e2e-changes-thread'
const isolatedId = 'e2e-changes-isolated'
const retiredId = 'e2e-changes-retired'
let root = ''
let isolatedRoot = ''
let retiredRoot = ''
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' })

async function summary() {
  return browser.execute(
    async (projectId, threadId) => {
      return window.api.git.threadChangeSummary([{ projectId, threadId }], { fresh: true })
    },
    projectId,
    threadId,
  )
}

describe('native sidebar thread changes', () => {
  before(async function () {
    this.timeout(120_000)
    root = mkdtempSync(join(tmpdir(), 'copse-native-changes-'))
    git('init', '-q')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.test')
    writeFileSync(join(root, 'README.md'), 'Changes fixture\n')
    git('add', '.')
    git('commit', '-qm', 'Initial')
    const managedRoot = process.env['COPSE_WORKTREES_DIR']
    if (!managedRoot) throw new Error('Missing isolated e2e worktrees root')
    isolatedRoot = join(managedRoot, projectId, isolatedId)
    retiredRoot = join(managedRoot, projectId, retiredId)
    rmSync(join(managedRoot, projectId), { recursive: true, force: true })
    mkdirSync(join(managedRoot, projectId), { recursive: true })
    git('worktree', 'add', '-q', '-b', 'changes-isolated', isolatedRoot)
    git('worktree', 'add', '-q', '-b', 'changes-retired', retiredRoot)
    git('worktree', 'remove', '--force', retiredRoot)
    writeFileSync(join(isolatedRoot, 'isolated-pending.txt'), 'Isolated pending work\n')
    writeFileSync(join(root, 'pending.txt'), 'Uncommitted work\n')
    resetUserData()
    const now = Date.now()
    const baseCommit = git('rev-parse', 'HEAD').trim()
    const baseBranch = git('branch', '--show-current').trim()
    const isolatedThread: Thread = {
      id: isolatedId,
      title: 'Review isolated work',
      status: 'idle',
      messages: [
        { id: 'isolated-user', role: 'user', content: 'Prepare isolated work', createdAt: now },
        {
          id: 'isolated-answer',
          role: 'assistant',
          content: 'Isolated work is ready.',
          createdAt: now + 1,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: now,
      updatedAt: now,
      worktree: {
        path: isolatedRoot,
        branch: 'changes-isolated',
        baseBranch,
        baseCommit,
        createdAt: now,
        seededFromDirtyProject: false,
      },
    }
    const retiredThread: Thread = {
      ...isolatedThread,
      id: retiredId,
      title: 'Retired work',
      worktree: {
        path: retiredRoot,
        branch: 'changes-retired',
        baseBranch,
        baseCommit,
        createdAt: now,
        seededFromDirtyProject: false,
        retiredAt: now,
        retiredHead: baseCommit,
      },
    }
    writeSeedConfig({
      projects: [{ id: projectId, name: 'changes-fixture', path: root }],
      activeProjectId: projectId,
      expandedProjectId: projectId,
      activeThreadId: threadId,
      [`threads:${projectId}`]: [
        isolatedThread,
        retiredThread,
        {
          id: threadId,
          title: 'Review uncommitted work',
          status: 'idle',
          messages: [
            { id: 'changes-user', role: 'user', content: 'Prepare the change', createdAt: now },
            {
              id: 'changes-answer',
              role: 'assistant',
              content: 'The change is ready for review.',
              createdAt: now + 1,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    writeSettings({ theme: 'dark' })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    if (root) {
      git('worktree', 'remove', '--force', isolatedRoot)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads real Git through IPC and displays the dirty glyph without changing the checkout', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForDisplayed({ timeout: 30_000 })
    expect(await summary()).toEqual([{ dirty: true }])
    await $(`.chat-row[data-thread-id="${threadId}"] .chat-changes-status`).waitForExist({
      timeout: 15_000,
    })
    await expect($(`.chat-row[data-thread-id="${threadId}"] .chat-changes-status`)).toHaveAttribute(
      'aria-label',
      'Uncommitted changes',
    )
    const before = git('status', '--porcelain')
    expect(await summary()).toEqual([{ dirty: true }])
    expect(git('status', '--porcelain')).toBe(before)
    await saveAppScreenshot('sidebar-thread-changes-native.png')
    git('add', '.')
    git('commit', '-qm', 'Save pending work')
    expect(await summary()).toEqual([{ dirty: false }])
    await $(`.chat-row[data-thread-id="${threadId}"] .chat-changes-status`).waitForExist({
      timeout: 30_000,
      reverse: true,
    })
    await saveAppScreenshot('sidebar-thread-changes-native-clean.png')
  })
  it('inspects a managed isolated checkout and leaves a retired one absent', async function () {
    this.timeout(60_000)
    const retiredMetaPath = join(e2eWorkspaceDir(), projectId, retiredId, 'meta.json')
    const before = {
      status: execFileSync('git', ['status', '--porcelain'], {
        cwd: isolatedRoot,
        encoding: 'utf8',
      }),
      registrations: git('worktree', 'list', '--porcelain'),
      retiredMeta: readFileSync(retiredMetaPath, 'utf8'),
    }
    expect(existsSync(retiredRoot)).toBe(false)
    const read = () =>
      browser.execute(
        async (projectId, isolatedId, retiredId) =>
          window.api.git.threadChangeSummary(
            [
              { projectId, threadId: isolatedId },
              { projectId, threadId: retiredId },
            ],
            { fresh: true },
          ),
        projectId,
        isolatedId,
        retiredId,
      )
    expect(await read()).toEqual([{ dirty: true }, null])
    expect(await read()).toEqual([{ dirty: true }, null])
    await $(`.chat-row[data-thread-id="${isolatedId}"] .chat-changes-status`).waitForExist({
      timeout: 15_000,
    })
    await expect(
      $(`.chat-row[data-thread-id="${retiredId}"] .chat-changes-status`),
    ).not.toBeExisting()
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: isolatedRoot, encoding: 'utf8' }),
    ).toBe(before.status)
    expect(git('worktree', 'list', '--porcelain')).toBe(before.registrations)
    expect(readFileSync(retiredMetaPath, 'utf8')).toBe(before.retiredMeta)
    expect(existsSync(retiredRoot)).toBe(false)
    await saveAppScreenshot('sidebar-thread-changes-native-isolated.png')
  })
})
