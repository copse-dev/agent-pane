import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  deleteThreadResourcesAndStore,
  type ThreadDeletionDependencies,
  type ThreadDeletionRuntime,
} from './thread-deletion.ts'
import { setGitAvailableForTest } from './tool-availability.ts'
import { clearAllowedWorkspaceRootsForTest } from './workspace.ts'
import {
  allocateThreadWorktree,
  listProjectWorktrees,
  retireDeletedThreadWorktree,
  type DeletedThreadWorktreeResult,
  type ValidateWorktreeInput,
} from './worktree-manager.ts'

const WORKTREE: ValidateWorktreeInput = {
  projectId: 'project-a',
  threadId: 'thread-a',
  projectRoot: '/repo',
  worktree: {
    path: '/worktrees/project-a/thread-a',
    branch: 'copse/thread-a',
    baseBranch: 'main',
    baseCommit: 'a'.repeat(40),
    createdAt: 1,
    seededFromDirtyProject: false,
  },
}

function harness(
  options: {
    failAt?: string
    worktree?: ValidateWorktreeInput | null
    retired?: DeletedThreadWorktreeResult
  } = {},
): {
  calls: string[]
  runtime: ThreadDeletionRuntime
  dependencies: ThreadDeletionDependencies
} {
  const calls: string[] = []
  const step = (name: string): void => {
    calls.push(name)
    if (options.failAt === name) throw new Error(`failed at ${name}`)
  }
  return {
    calls,
    runtime: {
      stopAndWaitForAgent: async (projectId, threadId): Promise<void> => {
        step(`stop:${projectId}:${threadId}`)
      },
      resumeAfterFailedDeletion: (projectId, threadId): void => {
        step(`resume:${projectId}:${threadId}`)
      },
      forgetAgentHistory: (projectId, threadId): void => {
        step(`forget:${projectId}:${threadId}`)
      },
    },
    dependencies: {
      cancelApprovals: (threadId): void => {
        step(`approvals:${threadId}`)
      },
      disposeAcp: async (threadId): Promise<void> => {
        step(`acp:${threadId}`)
      },
      destroyTerminals: async (threadId): Promise<void> => {
        step(`terminals:${threadId}`)
      },
      stopBackgroundProcesses: async ({ projectId, threadId }): Promise<void> => {
        step(`processes:${projectId}:${threadId}`)
      },
      findWorktree: async (projectId, threadId): Promise<ValidateWorktreeInput | null> => {
        step(`find-worktree:${projectId}:${threadId}`)
        return options.worktree ?? null
      },
      retireWorktree: async (input): Promise<DeletedThreadWorktreeResult> => {
        step(`retire-worktree:${input.worktree.path}`)
        return (
          options.retired ?? {
            status: 'removed',
            branch: input.worktree.branch,
            branchDeleted: true,
          }
        )
      },
      clearRemoteSession: (threadId): void => {
        step(`remote:${threadId}`)
      },
      clearRedaction: (threadId): void => {
        step(`redaction:${threadId}`)
      },
      clearModels: (threadId): void => {
        step(`models:${threadId}`)
      },
      clearReadRoots: (threadId): void => {
        step(`read-roots:${threadId}`)
      },
      clearToolCache: (threadId): void => {
        step(`tool-cache:${threadId}`)
      },
      clearDeniedOperations: (threadId): void => {
        step(`denials:${threadId}`)
      },
      deleteStore: async (projectId, threadId): Promise<void> => {
        step(`delete:${projectId}:${threadId}`)
      },
    },
  }
}

const CLEARS_AND_DELETE = [
  'remote:thread-a',
  'redaction:thread-a',
  'models:thread-a',
  'read-roots:thread-a',
  'tool-cache:thread-a',
  'denials:thread-a',
  'forget:project-a:thread-a',
  'delete:project-a:thread-a',
]

const STOPS = [
  'approvals:thread-a',
  'stop:project-a:thread-a',
  'acp:thread-a',
  'terminals:thread-a',
  'processes:project-a:thread-a',
]

describe('deleteThreadResourcesAndStore', () => {
  it('stops live work and clears thread-owned state before deleting the store', async () => {
    const { calls, runtime, dependencies } = harness()

    await deleteThreadResourcesAndStore('project-a', 'thread-a', runtime, dependencies)

    // A thread on the shared project checkout has no worktree to retire.
    assert.deepEqual(calls, [...STOPS, 'find-worktree:project-a:thread-a', ...CLEARS_AND_DELETE])
  })

  it('retires the worktree only after everything running inside it has stopped', async () => {
    const { calls, runtime, dependencies } = harness({ worktree: WORKTREE })

    await deleteThreadResourcesAndStore('project-a', 'thread-a', runtime, dependencies)

    assert.deepEqual(calls, [
      ...STOPS,
      'find-worktree:project-a:thread-a',
      'retire-worktree:/worktrees/project-a/thread-a',
      ...CLEARS_AND_DELETE,
    ])
  })

  for (const retired of [
    { status: 'blocked-dirty', paths: ['src/app.ts'] },
    { status: 'blocked-unmerged', branch: 'copse/thread-a', baseBranch: 'main' },
  ] satisfies DeletedThreadWorktreeResult[]) {
    it(`deletes the thread but keeps a ${retired.status} worktree`, async () => {
      const { calls, runtime, dependencies } = harness({ worktree: WORKTREE, retired })

      await deleteThreadResourcesAndStore('project-a', 'thread-a', runtime, dependencies)

      assert.deepEqual(calls.slice(-CLEARS_AND_DELETE.length), CLEARS_AND_DELETE)
      assert.equal(
        calls.some((call) => call.startsWith('resume:')),
        false,
      )
    })
  }

  for (const { step, failAt } of [
    { step: 'lookup', failAt: 'find-worktree:project-a:thread-a' },
    { step: 'removal', failAt: 'retire-worktree:/worktrees/project-a/thread-a' },
  ]) {
    it(`keeps the worktree and still deletes the thread when its ${step} fails`, async () => {
      const { calls, runtime, dependencies } = harness({ worktree: WORKTREE, failAt })

      await deleteThreadResourcesAndStore('project-a', 'thread-a', runtime, dependencies)

      assert.equal(calls.at(-1), 'delete:project-a:thread-a')
      assert.equal(
        calls.some((call) => call.startsWith('resume:')),
        false,
      )
    })
  }

  it('keeps the durable store when resource cleanup fails', async () => {
    const { calls, runtime, dependencies } = harness({ failAt: 'terminals:thread-a' })

    await assert.rejects(
      deleteThreadResourcesAndStore('project-a', 'thread-a', runtime, dependencies),
      /failed at terminals:thread-a/,
    )

    assert.deepEqual(calls, [
      'approvals:thread-a',
      'stop:project-a:thread-a',
      'acp:thread-a',
      'terminals:thread-a',
      'resume:project-a:thread-a',
    ])
  })

  it('keeps the dispatch fence if durable deletion itself fails', async () => {
    const { calls, runtime, dependencies } = harness({ failAt: 'delete:project-a:thread-a' })

    await assert.rejects(
      deleteThreadResourcesAndStore('project-a', 'thread-a', runtime, dependencies),
      /failed at delete:project-a:thread-a/,
    )

    assert.equal(calls.at(-1), 'delete:project-a:thread-a')
    assert.equal(
      calls.some((call) => call.startsWith('resume:')),
      false,
    )
  })
})

describe('deleteThreadResourcesAndStore with a real linked checkout', () => {
  const cleanups: string[] = []
  let previousRoot: string | undefined

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Copse Test',
        GIT_AUTHOR_EMAIL: 'copse@example.invalid',
        GIT_COMMITTER_NAME: 'Copse Test',
        GIT_COMMITTER_EMAIL: 'copse@example.invalid',
      },
    })
  }

  async function setup(): Promise<string> {
    previousRoot = process.env['COPSE_WORKTREES_DIR']
    const temp = await mkdtemp(join(tmpdir(), 'copse-thread-deletion-'))
    cleanups.push(temp)
    process.env['COPSE_WORKTREES_DIR'] = join(temp, 'worktrees')
    setGitAvailableForTest(true)
    const repo = join(temp, 'repo')
    await mkdir(repo, { recursive: true })
    git(repo, ['init', '-q', '-b', 'main'])
    await writeFile(join(repo, 'README.md'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'initial'])
    return repo
  }

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKTREES_DIR']
    else process.env['COPSE_WORKTREES_DIR'] = previousRoot
    previousRoot = undefined
    setGitAvailableForTest(null)
    clearAllowedWorkspaceRootsForTest()
    for (const path of cleanups.splice(0).reverse()) {
      await rm(path, { recursive: true, force: true })
    }
  })

  async function deleteWithWorktree(input: ValidateWorktreeInput): Promise<string[]> {
    const { calls, runtime, dependencies } = harness()
    await deleteThreadResourcesAndStore(input.projectId, input.threadId, runtime, {
      ...dependencies,
      findWorktree: async () => input,
      retireWorktree: retireDeletedThreadWorktree,
    })
    return calls
  }

  it('removes a clean checkout and keeps a dirty one, deleting both threads', async () => {
    const repo = await setup()
    const allocate = async (threadId: string): Promise<ValidateWorktreeInput> => ({
      projectId: 'project-a',
      threadId,
      projectRoot: repo,
      worktree: await allocateThreadWorktree({
        projectId: 'project-a',
        threadId,
        projectRoot: repo,
        prompt: `Delete ${threadId}`,
        baseBranch: 'main',
      }),
    })
    const clean = await allocate('thread-clean')
    const dirty = await allocate('thread-dirty')
    await writeFile(join(dirty.worktree.path, 'notes.txt'), 'unsaved\n')

    const cleanCalls = await deleteWithWorktree(clean)
    const dirtyCalls = await deleteWithWorktree(dirty)

    assert.equal(cleanCalls.at(-1), 'delete:project-a:thread-clean')
    assert.equal(dirtyCalls.at(-1), 'delete:project-a:thread-dirty')
    const paths = (await listProjectWorktrees(repo)).map((record) => record.path)
    assert.ok(!paths.includes(clean.worktree.path))
    await assert.rejects(lstat(clean.worktree.path), { code: 'ENOENT' })
    assert.equal(git(repo, ['branch', '--list', clean.worktree.branch]).trim(), '')
    assert.ok(paths.includes(dirty.worktree.path))
    assert.equal(await readFile(join(dirty.worktree.path, 'notes.txt'), 'utf-8'), 'unsaved\n')
    assert.notEqual(git(repo, ['branch', '--list', dirty.worktree.branch]).trim(), '')
  })
})
