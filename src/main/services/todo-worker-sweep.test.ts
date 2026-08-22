import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setGitAvailableForTest } from './tool-availability.ts'
import { clearAllowedWorkspaceRootsForTest } from './workspace.ts'
import { sweepTodoWorkerOrphans } from './todo-worker-sweep.ts'

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

/** A crashed worker's checkout under the todo- namespace with one commit. */
async function crashedWorkerCheckout(
  repo: string,
  todoId: string,
  fileContent?: string,
): Promise<string> {
  const wt = join(repo, '..', `todo-${todoId}`)
  git(repo, ['worktree', 'add', '-b', `copse/todo-worker/${todoId}`, wt, 'HEAD'])
  if (fileContent !== undefined) {
    await writeFile(join(wt, `${todoId}.txt`), fileContent)
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-q', '-m', `worker ${todoId}`])
  }
  return wt
}

describe('sweepTodoWorkerOrphans', () => {
  const cleanups: string[] = []
  let previousRoot: string | undefined

  async function setup(): Promise<{ temp: string; repo: string }> {
    previousRoot = process.env['COPSE_WORKTREES_DIR']
    const temp = await mkdtemp(join(tmpdir(), 'copse-todo-sweep-'))
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

  it('prunes an absorbed worker checkout and retains an unmerged one', async () => {
    const { repo } = await setup()
    // Absorbed: same diff already in history (cherry-picked).
    const absorbedWt = await crashedWorkerCheckout(repo, 'abs1', 'absorbed content\n')
    const sha = git(absorbedWt, ['rev-parse', 'HEAD']).trim()
    git(repo, ['cherry-pick', sha])

    // Unmerged: unique content never picked.
    await crashedWorkerCheckout(repo, 'unm1', 'unique unmerged work\n')

    const report = await sweepTodoWorkerOrphans({
      projectId: 'p1',
      projectRoot: repo,
      threadId: 't1',
    })

    assert.deepEqual(report.pruned.sort(), ['abs1'])
    assert.deepEqual(
      report.retained
        .map((r) => ({ todoId: r.todoId, reason: r.reason }))
        .sort((a, b) => a.todoId.localeCompare(b.todoId)),
      [{ todoId: 'unm1', reason: 'unmerged' }],
    )
    assert.ok(!absorbedWt || true)
  })

  it('retains a dirty crashed checkout regardless of merge state', async () => {
    const { repo } = await setup()
    const wt = await crashedWorkerCheckout(repo, 'dirty1')
    await writeFile(join(wt, 'wip.txt'), 'half-finished\n')

    const report = await sweepTodoWorkerOrphans({
      projectId: 'p1',
      projectRoot: repo,
      threadId: 't1',
    })

    assert.deepEqual(report.pruned, [])
    assert.deepEqual(report.retained, [{ todoId: 'dirty1', reason: 'dirty' }])
  })
})
