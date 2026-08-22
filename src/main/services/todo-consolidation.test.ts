import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setGitAvailableForTest } from './tool-availability.ts'
import { clearAllowedWorkspaceRootsForTest } from './workspace.ts'
import { consolidateTodoWorkers, discardTodoWorkerBranch } from './todo-consolidation.ts'

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

/** Worker branch with one commit touching `file`. */
async function workerBranch(
  repo: string,
  todoId: string,
  file: string,
  content: string,
  branchTodoId = todoId,
): Promise<string> {
  const branch = `copse/todo-worker/${branchTodoId}`
  const wt = join(repo, '..', `wt-${todoId}`)
  git(repo, ['worktree', 'add', '-b', branch, wt, 'HEAD'])
  await writeFile(join(wt, file), content)
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-q', '-m', `worker ${todoId}`])
  git(repo, ['worktree', 'remove', wt])
  return branch
}

describe('consolidateTodoWorkers', () => {
  const cleanups: string[] = []
  let previousRoot: string | undefined

  async function setup(): Promise<{ temp: string; repo: string }> {
    previousRoot = process.env['COPSE_WORKTREES_DIR']
    const temp = await mkdtemp(join(tmpdir(), 'copse-consolidation-'))
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

  it('refuses to consolidate a dirty workspace', async () => {
    const { repo } = await setup()
    await writeFile(join(repo, 'scratch.txt'), 'parent work\n')
    const report = await consolidateTodoWorkers({ projectRoot: repo, orderedTodoIds: ['t1'] })
    assert.equal(report.clean, false)
    assert.match(report.message, /uncommitted/)
  })

  it('merges disjoint worker commits in plan order onto the thread branch', async () => {
    const { repo } = await setup()
    await workerBranch(repo, 'ta', 'a.txt', 'alpha\n')
    await workerBranch(repo, 'tb', 'b.txt', 'beta\n')
    const report = await consolidateTodoWorkers({
      projectRoot: repo,
      orderedTodoIds: ['ta', 'tb'],
    })
    assert.equal(report.clean, true)
    assert.equal(report.outcomes.filter((o) => o.status === 'merged').length, 2)
    // Both files landed; history carries one commit per todo in plan order.
    assert.equal(git(repo, ['log', '--format=%s', '-2']).trim().split('\n')[0], 'worker tb')
    assert.ok(git(repo, ['show', 'HEAD:a.txt']).includes('alpha'))
  })

  it('reports a conflict without aborting later independent picks', async () => {
    const { repo } = await setup()
    await workerBranch(repo, 'tc', 'shared.txt', 'from tc\n')
    await workerBranch(repo, 'td', 'shared.txt', 'from td\n')
    await workerBranch(repo, 'te', 'e.txt', 'echo\n')
    const report = await consolidateTodoWorkers({
      projectRoot: repo,
      orderedTodoIds: ['tc', 'td', 'te'],
    })
    assert.equal(report.clean, false)
    const conflicted = report.outcomes.find((o) => o.status === 'conflicted')
    assert.ok(conflicted, 'expected a conflicted outcome')
    assert.deepEqual('conflictingPaths' in conflicted ? conflicted.conflictingPaths : [], [
      'shared.txt',
    ])
    // te still merged even though td conflicted.
    assert.ok(report.outcomes.some((o) => o.status === 'merged' && o.todoId === 'te'))
    // No conflicted index left behind.
    assert.equal(git(repo, ['status', '--porcelain']).trim(), '')
  })

  it('second run reports already-merged instead of re-picking', async () => {
    const { repo } = await setup()
    await workerBranch(repo, 'tf', 'f.txt', 'f\n')
    const first = await consolidateTodoWorkers({ projectRoot: repo, orderedTodoIds: ['tf'] })
    assert.equal(first.clean, true)
    const second = await consolidateTodoWorkers({ projectRoot: repo, orderedTodoIds: ['tf'] })
    assert.equal(second.clean, true)
    assert.equal(second.outcomes[0]?.status, 'already-merged')
  })

  it('uses an exact collision-suffixed batch branch instead of an older attempt', async () => {
    const { repo } = await setup()
    await workerBranch(repo, 'old-attempt', 'old.txt', 'old\n', 'retry')
    const branch = await workerBranch(repo, 'new-attempt', 'new.txt', 'new\n', 'retry-2')
    const sha = git(repo, ['rev-parse', branch]).trim()
    const report = await consolidateTodoWorkers({
      projectRoot: repo,
      orderedTodoIds: ['retry'],
      workers: [{ todoId: 'retry', branch, sha }],
    })

    assert.equal(report.clean, true)
    assert.ok(git(repo, ['show', 'HEAD:new.txt']).includes('new'))
    assert.throws(() => git(repo, ['show', 'HEAD:old.txt']))
  })

  it('discard removes the worker branch', async () => {
    const { repo } = await setup()
    const branch = await workerBranch(repo, 'tg', 'g.txt', 'g\n')
    const result = await discardTodoWorkerBranch(repo, 'tg')
    assert.equal(result.discarded, true)
    assert.throws(() => git(repo, ['rev-parse', '--verify', branch]))
  })
})
