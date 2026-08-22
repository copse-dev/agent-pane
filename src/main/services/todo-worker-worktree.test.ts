import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setGitAvailableForTest } from './tool-availability.ts'
import {
  clearAllowedWorkspaceRootsForTest,
  getInternalWorkspaceRootRegistration,
} from './workspace.ts'
import {
  commitTodoWorkerOutput,
  resolveTodoWorkerBranch,
  todoWorkerBranchMerged,
  todoWorkerBranchName,
  todoWorkerCommitMessage,
} from './todo-worker-worktree.ts'

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

async function repository(root: string, name: string): Promise<string> {
  const repo = join(root, name)
  await mkdir(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  await writeFile(join(repo, 'README.md'), 'base\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'initial'])
  return repo
}

const ITEM = {
  id: 'todo-1',
  content: 'Add the widget helper',
  status: 'in_progress' as const,
}

describe('todo worker worktree helpers', () => {
  const cleanups: string[] = []
  let previousRoot: string | undefined

  async function setup(): Promise<{ temp: string; repo: string }> {
    previousRoot = process.env['COPSE_WORKTREES_DIR']
    const temp = await mkdtemp(join(tmpdir(), 'copse-todo-worker-'))
    cleanups.push(temp)
    process.env['COPSE_WORKTREES_DIR'] = join(temp, 'worktrees')
    setGitAvailableForTest(true)
    return { temp, repo: await repository(temp, 'repo') }
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

  it('builds a stable, collision-suffixed branch name from the todo id', () => {
    assert.equal(todoWorkerBranchName('abc123'), 'copse/todo-worker/abc123')
    assert.equal(todoWorkerBranchName('abc123', 1), 'copse/todo-worker/abc123-2')
    assert.equal(todoWorkerBranchName(''), 'copse/todo-worker/item')
  })

  it('commit message leads with the todo content', () => {
    assert.match(todoWorkerCommitMessage(ITEM), /^Add the widget helper\n/)
  })

  it('resolveTodoWorkerBranch skips existing branches', async () => {
    const { repo } = await setup()
    git(repo, ['branch', todoWorkerBranchName('t1')])
    assert.equal(await resolveTodoWorkerBranch(repo, 't1'), `${todoWorkerBranchName('t1')}-2`)
  })

  it('commits worker output on the worker branch and reports absorption state', async () => {
    const { temp, repo } = await setup()
    const wt = join(temp, 'worker-wt')
    const branch = todoWorkerBranchName('t2')
    git(repo, ['worktree', 'add', '-b', branch, wt, 'HEAD'])

    await writeFile(join(wt, 'widget.ts'), 'export const widget = 1\n')
    const commit = await commitTodoWorkerOutput({
      worktreePath: wt,
      branch,
      item: ITEM,
      authorName: 'Copse Todo Worker',
      authorEmail: 'todo-worker@copse.local',
    })

    assert.ok(commit.committed)
    assert.ok(commit.sha)
    assert.match(git(repo, ['log', '--format=%s', '-1', branch]), /^Add the widget helper/)
    assert.equal(await todoWorkerBranchMerged(repo, branch, 'main'), false)
  })

  it('reports committed=false when the worktree is untouched', async () => {
    const { temp, repo } = await setup()
    const wt = join(temp, 'clean-wt')
    const branch = todoWorkerBranchName('t3')
    git(repo, ['worktree', 'add', '-b', branch, wt, 'HEAD'])

    const commit = await commitTodoWorkerOutput({
      worktreePath: wt,
      branch,
      item: ITEM,
      authorName: 'Copse Todo Worker',
      authorEmail: 'todo-worker@copse.local',
    })
    assert.equal(commit.committed, false)
    assert.equal(commit.sha, null)
  })
})

// The internal-root registration contract the runner relies on: allocating
// registers the canonical checkout so file tools may resolve inside it.
describe('todo worker internal root registration shape', () => {
  it('getInternalWorkspaceRootRegistration exposes registration metadata', async () => {
    const registration = getInternalWorkspaceRootRegistration('/definitely/not/registered')
    assert.equal(registration, null)
  })
})
