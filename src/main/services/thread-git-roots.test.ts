import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import type { Thread } from '@shared/types/thread.ts'
import type { ThreadWorktree } from '@shared/types/worktree.ts'
import {
  checkoutThreadGitBranch,
  resolveWatchedGitExecutionRoot,
  resolveWatchedGitRoot,
} from './thread-git-roots.ts'
import {
  inspectThreadCheckoutRoot,
  inspectThreadReadContext,
  inspectThreadReadRoot,
  resolveThreadExecutionContext,
  resolveThreadTerminalExecutionContext,
  runWithThreadExecutionContext,
} from './thread-execution-context.ts'
import {
  getBranches,
  getCurrentBranchName,
  getGitPromptState,
  getGitStatus,
} from './github/git-service.ts'
import {
  createThread,
  getThreadMeta,
  saveAgentTurnEpoch,
  updateMetaOrThrow,
} from './thread-store.ts'
import { storageGet, storageSet } from './storage/storage.ts'
import { allocateThreadWorktree } from './worktree-manager.ts'
import { releaseCompletedAutomationWorktree } from './worktree-parking.ts'
import { stopWorkspaceIndexWatcher } from './search/workspace-index-watcher.ts'
import { setGitAvailableForTest } from './tool-availability.ts'
import { clearAllowedWorkspaceRootsForTest } from './workspace.ts'
import { AppRunService } from './app-run/app-run-service.ts'
import { suggestThreadFollowUps } from './follow-up-service.ts'
import { getSetting, setSetting } from './storage/settings.ts'
import { threadProjectExecutionTarget } from './ssh-workspace/execution-target.ts'

const PROJECT = 'git-inspection-project'
const THREAD = 'finished-check'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

describe('thread Git roots with real checkout lifecycle and queued store', () => {
  let root = ''
  let repo = ''
  let previousWorktrees: string | undefined
  let previousWorkspace: string | undefined
  let previousProjects: unknown
  let previousActiveProject: unknown

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copse-git-inspection-'))
    previousWorktrees = process.env['COPSE_WORKTREES_DIR']
    previousWorkspace = process.env['COPSE_WORKSPACE_DIR']
    previousProjects = storageGet('projects')
    previousActiveProject = storageGet('activeProjectId')
    process.env['COPSE_WORKTREES_DIR'] = join(root, 'worktrees')
    process.env['COPSE_WORKSPACE_DIR'] = join(root, 'workspace')
    configureThreadStore({
      workspaceRoot: () => join(root, 'workspace'),
      listProjectIds: () => [PROJECT],
    })
    setGitAvailableForTest(true)
    repo = join(root, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.name', 'Copse Test'])
    git(repo, ['config', 'user.email', 'copse@example.invalid'])
    writeFileSync(join(repo, 'README.md'), 'base\n')
    git(repo, ['add', 'README.md'])
    git(repo, ['commit', '-qm', 'base'])
    storageSet('projects', [{ id: PROJECT, path: repo, name: 'Inspection project' }])
  })

  afterEach(() => {
    stopWorkspaceIndexWatcher()
    storageSet('projects', previousProjects)
    storageSet('activeProjectId', previousActiveProject)
    configureThreadStore()
    if (previousWorktrees === undefined) delete process.env['COPSE_WORKTREES_DIR']
    else process.env['COPSE_WORKTREES_DIR'] = previousWorktrees
    if (previousWorkspace === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousWorkspace
    setGitAvailableForTest(null)
    clearAllowedWorkspaceRootsForTest()
    rmSync(root, { recursive: true, force: true })
  })

  async function seed(): Promise<Thread & { worktree: ThreadWorktree }> {
    const worktree = await allocateThreadWorktree({
      projectId: PROJECT,
      threadId: THREAD,
      projectRoot: repo,
      prompt: 'Finished inspection check',
      baseBranch: 'main',
      seedFromDirtyProject: false,
    })
    const thread: Thread & { worktree: ThreadWorktree } = {
      id: THREAD,
      title: 'Finished check',
      status: 'idle',
      messages: [
        { id: 'answer', role: 'assistant', content: 'Finished.', toolCalls: [], createdAt: 1 },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      automation: { scheduleId: 'checks', scheduleName: 'Checks', triggeredAt: 1 },
      worktree,
      worktreeChoice: 'worktree',
      gitBranch: worktree.branch,
      createdAt: 1,
      updatedAt: 1,
    }
    await createThread(PROJECT, thread)
    return thread
  }

  function rawMeta(): Buffer {
    return readFileSync(join(root, 'workspace', PROJECT, THREAD, 'meta.json'))
  }

  it('does not recreate or rewrite a released checkout for a passive current-branch getter', async () => {
    const thread = await seed()
    await saveAgentTurnEpoch(PROJECT, THREAD, { turnTreeId: 'original-tree', continuationUsed: 1 })
    assert.deepEqual(await releaseCompletedAutomationWorktree(PROJECT, THREAD), { released: true })
    const before = rawMeta()
    const spinePath = join(root, 'workspace', PROJECT, THREAD, 'events.jsonl')
    const epochPath = join(root, 'workspace', PROJECT, THREAD, 'agent-epoch.json')
    const spine = readFileSync(spinePath)
    const epoch = readFileSync(epochPath)
    const retiredAt = (await getThreadMeta(PROJECT, THREAD))?.worktree?.retiredAt
    assert.ok(retiredAt)
    assert.equal(existsSync(thread.worktree.path), false)
    const rootForRead = await resolveWatchedGitRoot(PROJECT, THREAD)
    const branch = await getCurrentBranchName(rootForRead)
    const current = await getThreadMeta(PROJECT, THREAD)
    console.log(
      '[passive-git-root-control]',
      JSON.stringify({
        beforeRetiredAt: retiredAt,
        afterRetiredAt: current?.worktree?.retiredAt ?? null,
        samePath: current?.worktree?.path === thread.worktree.path,
        directoryExists: existsSync(thread.worktree.path),
        rootForRead,
        epochPreserved: readFileSync(epochPath).equals(epoch),
        spinePreserved: readFileSync(spinePath).equals(spine),
      }),
    )
    assert.equal(current?.worktree?.retiredAt, retiredAt)
    assert.deepEqual(rawMeta(), before)
    assert.deepEqual(readFileSync(spinePath), spine)
    assert.deepEqual(readFileSync(epochPath), epoch)
    assert.equal(existsSync(thread.worktree.path), false)
    assert.equal(rootForRead, null)
    assert.equal(branch, null)
  })

  it('still restores a released checkout for an intentional execution context', async () => {
    const thread = await seed()
    assert.deepEqual(await releaseCompletedAutomationWorktree(PROJECT, THREAD), { released: true })
    assert.equal(existsSync(thread.worktree.path), false)
    const context = await resolveThreadExecutionContext(PROJECT, THREAD)
    assert.equal(context.root, thread.worktree.path)
    assert.equal(existsSync(thread.worktree.path), true)
    assert.equal((await getThreadMeta(PROJECT, THREAD))?.worktree?.retiredAt, undefined)
  })

  it('retains restoration for an intentional terminal context', async () => {
    const thread = await seed()
    assert.deepEqual(await releaseCompletedAutomationWorktree(PROJECT, THREAD), { released: true })
    const context = await resolveThreadTerminalExecutionContext(PROJECT, THREAD)
    assert.equal(context.root, thread.worktree.path)
    assert.equal(existsSync(thread.worktree.path), true)
    assert.equal((await getThreadMeta(PROJECT, THREAD))?.worktree?.retiredAt, undefined)
  })

  it('does not restore a released checkout while detecting app capabilities', async () => {
    const thread = await seed()
    assert.deepEqual(await releaseCompletedAutomationWorktree(PROJECT, THREAD), { released: true })
    const before = rawMeta()
    const retiredAt = (await getThreadMeta(PROJECT, THREAD))?.worktree?.retiredAt
    assert.ok(retiredAt)
    const service = new AppRunService()
    assert.equal(await service.detect({ projectId: PROJECT, threadId: THREAD }), false)
    assert.equal((await getThreadMeta(PROJECT, THREAD))?.worktree?.retiredAt, retiredAt)
    assert.deepEqual(rawMeta(), before)
    assert.equal(existsSync(thread.worktree.path), false)
  })

  it('retains intentional app discovery restoration on supported hosts', async () => {
    const thread = await seed()
    assert.deepEqual(await releaseCompletedAutomationWorktree(PROJECT, THREAD), { released: true })
    const service = new AppRunService()
    const owner = { projectId: PROJECT, threadId: THREAD }
    if (process.platform !== 'darwin') {
      await assert.rejects(service.discover(owner), /requires a local macOS project/)
      assert.equal(existsSync(thread.worktree.path), false)
      return
    }
    await service.discover(owner)
    assert.equal(existsSync(thread.worktree.path), true)
    assert.equal((await getThreadMeta(PROJECT, THREAD))?.worktree?.retiredAt, undefined)
  })

  it('does not restore a released checkout while polling app operation history', async () => {
    const thread = await seed()
    assert.deepEqual(await releaseCompletedAutomationWorktree(PROJECT, THREAD), { released: true })
    const before = rawMeta()
    const service = new AppRunService()
    const owner = { projectId: PROJECT, threadId: THREAD }
    if (process.platform === 'darwin') assert.deepEqual(await service.operations(owner), [])
    else await assert.rejects(service.operations(owner), /requires a local macOS project/)
    assert.ok(rawMeta().equals(before))
    assert.equal(existsSync(thread.worktree.path), false)
  })

  it('does not restore a released checkout for the real automatic follow-up request', async () => {
    const thread = await seed()
    assert.deepEqual(await releaseCompletedAutomationWorktree(PROJECT, THREAD), { released: true })
    const before = rawMeta()
    const retiredAt = (await getThreadMeta(PROJECT, THREAD))?.worktree?.retiredAt
    assert.ok(retiredAt)
    const previous = process.env['COPSE_PANEL_MOCK_FOLLOW_UPS']
    process.env['COPSE_PANEL_MOCK_FOLLOW_UPS'] = '1'
    try {
      const suggestions = await suggestThreadFollowUps(PROJECT, THREAD, {
        userMessage: 'Check the release.',
        assistantMessage: 'The release is ready.',
        toolNames: [],
      })
      assert.equal((await getThreadMeta(PROJECT, THREAD))?.worktree?.retiredAt, retiredAt)
      assert.deepEqual(rawMeta(), before)
      assert.equal(existsSync(thread.worktree.path), false)
      assert.deepEqual(suggestions, [])
    } finally {
      if (previous === undefined) delete process.env['COPSE_PANEL_MOCK_FOLLOW_UPS']
      else process.env['COPSE_PANEL_MOCK_FOLLOW_UPS'] = previous
    }
  })

  it('still offers automatic follow-ups for an existing checkout', async () => {
    const thread = await seed()
    const before = rawMeta()
    const previous = process.env['COPSE_PANEL_MOCK_FOLLOW_UPS']
    process.env['COPSE_PANEL_MOCK_FOLLOW_UPS'] = '1'
    try {
      const suggestions = await suggestThreadFollowUps(PROJECT, THREAD, {
        userMessage: 'Check the release.',
        assistantMessage: 'The release is ready.',
        toolNames: [],
      })
      assert.ok(suggestions.length > 0)
      assert.deepEqual(rawMeta(), before)
      assert.equal(existsSync(thread.worktree.path), true)
    } finally {
      if (previous === undefined) delete process.env['COPSE_PANEL_MOCK_FOLLOW_UPS']
      else process.env['COPSE_PANEL_MOCK_FOLLOW_UPS'] = previous
    }
  })

  it('restores for the submit/checkout path before capturing prompt state', async () => {
    const thread = await seed()
    const head = git(thread.worktree.path, ['rev-parse', 'HEAD'])
    assert.deepEqual(await releaseCompletedAutomationWorktree(PROJECT, THREAD), { released: true })
    const rootForExecution = await resolveWatchedGitExecutionRoot(PROJECT, THREAD)
    assert.equal(rootForExecution, thread.worktree.path)
    assert.deepEqual(await getGitPromptState(rootForExecution), {
      startingCommit: head,
      dirty: false,
    })
    assert.equal(existsSync(thread.worktree.path), true)
    assert.equal((await getThreadMeta(PROJECT, THREAD))?.worktree?.retiredAt, undefined)
  })

  it('keeps active dirty PR worktrees inspectable without modifying their ownership', async () => {
    const thread = await seed()
    await updateMetaOrThrow(PROJECT, THREAD, {
      worktree: {
        ...thread.worktree,
        pullRequestUrl: 'https://github.com/copse-dev/example/pull/1',
      },
    })
    writeFileSync(join(thread.worktree.path, 'README.md'), 'uncommitted PR follow-up\n')
    const before = rawMeta()
    assert.equal(
      await inspectThreadCheckoutRoot(PROJECT, THREAD),
      null,
      'sidebar PR policy stays unchanged',
    )
    const rootForRead = await resolveWatchedGitRoot(PROJECT, THREAD)
    assert.equal(rootForRead, thread.worktree.path)
    const status = await getGitStatus(rootForRead)
    assert.ok(status?.unstaged.some((change) => change.path === 'README.md'))
    assert.deepEqual(rawMeta(), before)
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'base\n')
  })

  it('restores and records an explicitly selected branch without relying on a passive read', async () => {
    const thread = await seed()
    git(repo, ['branch', 'chosen-branch'])
    assert.deepEqual(await releaseCompletedAutomationWorktree(PROJECT, THREAD), { released: true })
    await checkoutThreadGitBranch(PROJECT, THREAD, 'chosen-branch')
    assert.equal(git(thread.worktree.path, ['branch', '--show-current']), 'chosen-branch')
    const current = await getThreadMeta(PROJECT, THREAD)
    assert.ok(current)
    assert.ok(current.worktree)
    assert.equal(current.worktree.retiredAt, undefined)
    assert.equal(current.worktree.branch, 'chosen-branch')
    assert.equal(current.gitBranch, 'chosen-branch')
    const beforeRead = rawMeta()
    assert.equal(
      await getCurrentBranchName(await resolveWatchedGitRoot(PROJECT, THREAD)),
      'chosen-branch',
    )
    assert.deepEqual(rawMeta(), beforeRead)
  })

  it('can inspect a detached checkout without adopting or repairing it', async () => {
    const thread = await seed()
    git(thread.worktree.path, ['switch', '--detach'])
    const before = rawMeta()
    const rootForRead = await resolveWatchedGitRoot(PROJECT, THREAD)
    assert.equal(rootForRead, thread.worktree.path)
    assert.equal(await getCurrentBranchName(rootForRead), null)
    assert.ok(await getGitStatus(rootForRead))
    assert.deepEqual(rawMeta(), before)
  })

  it('does not restore a missing live checkout or fall back to the shared repository', async () => {
    const thread = await seed()
    git(repo, ['worktree', 'remove', thread.worktree.path])
    const before = rawMeta()
    assert.equal(await resolveWatchedGitRoot(PROJECT, THREAD), null)
    assert.deepEqual(rawMeta(), before)
    assert.equal(existsSync(thread.worktree.path), false)
  })

  it('does not let a managed directory without its own Git marker read an enclosing repository', async () => {
    process.env['COPSE_WORKTREES_DIR'] = join(repo, 'managed-checkouts')
    const thread = await seed()
    rmSync(join(thread.worktree.path, '.git'))
    assert.equal(git(thread.worktree.path, ['branch', '--show-current']), 'main')
    const before = rawMeta()
    const rootForRead = await resolveWatchedGitRoot(PROJECT, THREAD)
    assert.equal(rootForRead, null)
    assert.equal(await getCurrentBranchName(rootForRead), null)
    assert.deepEqual(await getBranches(rootForRead), [])
    assert.deepEqual(rawMeta(), before)
    assert.equal(existsSync(thread.worktree.path), true)
    assert.equal(existsSync(join(thread.worktree.path, '.git')), false)
  })

  it('rejects an unowned recorded path instead of reading the shared repository', async () => {
    const thread = await seed()
    await updateMetaOrThrow(PROJECT, THREAD, { worktree: { ...thread.worktree, path: repo } })
    const before = rawMeta()
    assert.equal(await resolveWatchedGitRoot(PROJECT, THREAD), null)
    assert.deepEqual(rawMeta(), before)
  })

  it('reads a shared thread from its owning project and rejects unknown ownership', async () => {
    const thread = await seed()
    const { worktree: _worktree, ...shared } = thread
    await createThread(PROJECT, { ...shared, id: 'shared-thread' })
    storageSet('activeProjectId', 'another-project')
    assert.equal(await resolveWatchedGitRoot(PROJECT, 'shared-thread'), repo)
    assert.equal(await resolveWatchedGitRoot('another-project', THREAD), null)
    assert.equal(await resolveWatchedGitRoot(PROJECT, 'unknown-thread'), null)
    const subdirectory = join(repo, 'packages', 'app')
    mkdirSync(subdirectory, { recursive: true })
    storageSet('projects', [{ id: PROJECT, path: subdirectory, name: 'Nested shared project' }])
    assert.equal(await resolveWatchedGitRoot(PROJECT, 'shared-thread'), subdirectory)
    assert.equal(await getCurrentBranchName(subdirectory), 'main')
  })

  it('keeps passive read context bound to its owning SSH project when another project is active', async () => {
    const thread = await seed()
    const { worktree: _worktree, ...shared } = thread
    await createThread(PROJECT, { ...shared, id: 'shared-thread' })
    const previousEnabled = getSetting('sshWorkspaceEnabled', false)
    const previousHosts = getSetting<unknown[]>('sshWorkspaceHosts', [])
    try {
      await setSetting('sshWorkspaceEnabled', true)
      await setSetting('sshWorkspaceHosts', [
        { id: 'read-owner', label: 'Read owner', host: 'read.example.invalid', user: 'copse' },
      ])
      storageSet('projects', [
        { id: PROJECT, path: repo, name: 'SSH owner', sshHost: 'read-owner' },
        { id: 'other-project', path: '/other-local-project', name: 'Other local project' },
      ])
      storageSet('activeProjectId', 'other-project')
      const context = await inspectThreadReadContext(PROJECT, 'shared-thread')
      assert.ok(context)
      assert.equal(context.projectId, PROJECT)
      assert.equal(context.projectRoot, repo)
      assert.equal(context.root, repo)
      assert.equal(context.checkoutMode, 'shared')
      assert.deepEqual(runWithThreadExecutionContext(context, threadProjectExecutionTarget), {
        kind: 'ssh',
        hostId: 'read-owner',
        remoteRoot: repo,
      })
      assert.equal(await inspectThreadReadContext('other-project', 'shared-thread'), null)
    } finally {
      await setSetting('sshWorkspaceEnabled', previousEnabled)
      await setSetting('sshWorkspaceHosts', previousHosts)
    }
  })

  it('never restores when cleanup wins after a passive metadata read', async () => {
    const thread = await seed()
    const captured = await getThreadMeta(PROJECT, THREAD)
    assert.ok(captured)
    let metadataRead = (): void => {}
    let releaseRead = (): void => {}
    const observed = new Promise<void>((resolve): void => {
      metadataRead = resolve
    })
    const gate = new Promise<void>((resolve): void => {
      releaseRead = resolve
    })
    const inspecting = inspectThreadReadRoot(PROJECT, THREAD, {
      getProjectRoot: () => repo,
      getThreadMeta: async (): Promise<typeof captured> => {
        metadataRead()
        await gate
        return captured
      },
    })
    await observed
    assert.deepEqual(await releaseCompletedAutomationWorktree(PROJECT, THREAD), { released: true })
    const before = rawMeta()
    releaseRead()
    assert.equal(await inspecting, null)
    assert.deepEqual(rawMeta(), before)
    assert.equal(existsSync(thread.worktree.path), false)
  })
})
