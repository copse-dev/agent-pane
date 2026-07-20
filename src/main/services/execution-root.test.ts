import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitStatusTool } from '../tools/git-tools.ts'
import { runShellTool } from '../tools/shell-tool.ts'
import { writeFileTool } from '../tools/write-file-tool.ts'
import { clearDiffQueueForTest } from './diff-queue.ts'
import { getAgentExecutionRoot, getAgentProjectRoot } from './execution-root.ts'
import { setGitAvailableForTest } from './tool-availability.ts'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from './thread-execution-context.ts'
import { clearSessionBackupsForTest, ensureSessionBackup } from './worktree-backup.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

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

describe('thread execution roots', () => {
  const cleanups: Array<() => void | Promise<void>> = []

  afterEach(async () => {
    clearDiffQueueForTest()
    clearSessionBackupsForTest()
    setGitAvailableForTest(null)
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  it('isolates file, shell, git, diff, and backup primitives across concurrent contexts', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'copse-project-root-')))
    const rootA = await realpath(await mkdtemp(join(tmpdir(), 'copse-thread-root-a-')))
    const rootB = await realpath(await mkdtemp(join(tmpdir(), 'copse-thread-root-b-')))
    cleanups.push(async () => rm(projectRoot, { recursive: true, force: true }))
    cleanups.push(async () => rm(rootA, { recursive: true, force: true }))
    cleanups.push(async () => rm(rootB, { recursive: true, force: true }))
    cleanups.push(setWorkspaceRootForTest(projectRoot))
    setGitAvailableForTest(true)

    for (const root of [rootA, rootB]) {
      git(root, ['init', '-q'])
      git(root, ['commit', '--allow-empty', '-m', 'initial'])
    }

    const context = (threadId: string, root: string, branch: string): ThreadExecutionContext => ({
      projectId: 'project',
      threadId,
      projectRoot,
      root,
      checkoutMode: 'worktree',
      branch,
    })
    const signal = new AbortController().signal

    const run = async (
      ctx: ThreadExecutionContext,
      content: string,
    ): Promise<{ shell: string; status: string; backupRef: string }> =>
      runWithThreadExecutionContext(ctx, async () => {
        assert.equal(getAgentExecutionRoot(), ctx.root)
        assert.equal(getAgentProjectRoot(), projectRoot)

        const shell = await runShellTool.execute({ command: 'pwd', timeout_ms: 10_000 }, signal)
        await writeFileTool.execute({ path: 'same.txt', content }, signal)
        const status = await gitStatusTool.execute({}, signal)
        const backup = await ensureSessionBackup()
        assert.ok(backup)
        if (typeof shell !== 'string' || typeof status !== 'string') {
          throw new Error('Expected text results from shell and git status tools')
        }
        return { shell, status, backupRef: backup.ref }
      })

    const [a, b] = await Promise.all([
      run(context('thread-a', rootA, 'thread-a'), 'from a\n'),
      run(context('thread-b', rootB, 'thread-b'), 'from b\n'),
    ])

    assert.equal(a.shell, rootA)
    assert.equal(b.shell, rootB)
    assert.match(a.status, /same\.txt/)
    assert.match(b.status, /same\.txt/)
    assert.equal(await readFile(join(rootA, 'same.txt'), 'utf-8'), 'from a\n')
    assert.equal(await readFile(join(rootB, 'same.txt'), 'utf-8'), 'from b\n')
    await assert.rejects(readFile(join(projectRoot, 'same.txt'), 'utf-8'))
    assert.equal(git(rootA, ['show', `${a.backupRef}:same.txt`]), 'from a\n')
    assert.equal(git(rootB, ['show', `${b.backupRef}:same.txt`]), 'from b\n')
  })
})
