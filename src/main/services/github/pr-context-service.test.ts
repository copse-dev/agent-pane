import { describe, it, after, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { branchHasOpenPr, getPrWorkspaceContext } from './pr-context-service.ts'
import { invalidateGitWorkTreeProbe, resetDefaultBranchCache } from './git-service.ts'
import { setGhAvailableForTest, setGitAvailableForTest } from '../tool-availability.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'

describe('branchHasOpenPr', () => {
  after(() => {
    setGhAvailableForTest(null)
  })

  it('answers "no PR" without spawning when gh is unavailable', async () => {
    setGhAvailableForTest(false)
    assert.equal(await branchHasOpenPr('project-1', 'feature', '/tmp/repo'), false)
  })

  it('answers "no PR" outside a workspace', async () => {
    setGhAvailableForTest(true)
    assert.equal(await branchHasOpenPr('project-1', 'feature', null), false)
  })
})

const gitOk = spawnSync('git', ['--version']).status === 0

// Follow-up context reads the checkout without a user action. Under a writable
// overlay, Linux bubblewrap would leave write-deny placeholders (.bashrc,
// .vscode, ...) in it that `git status` then reports as untracked files.
describe('getPrWorkspaceContext under the project sandbox', { skip: !gitOk }, () => {
  let repo = ''
  const overlays: (Partial<SandboxRuntimeConfig> | undefined)[] = []

  before(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'copse-pr-context-sandboxed-')))
    const git = (...args: string[]): void => {
      spawnSync('git', args, { cwd: repo })
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(join(repo, 'tracked.txt'), 'one\n')
    git('add', 'tracked.txt')
    git('commit', '-qm', 'init')
    setGitAvailableForTest(true)
    setGhAvailableForTest(false)
    invalidateGitWorkTreeProbe()
    resetDefaultBranchCache()
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    mock.method(SandboxManager, 'cleanupAfterCommand', () => {})
    mock.method(
      SandboxManager,
      'wrapWithSandboxArgv',
      (command: string, _shell?: string, customConfig?: Partial<SandboxRuntimeConfig>) => {
        overlays.push(customConfig)
        // Run the real Git command unconfined; only the overlay is under test.
        return Promise.resolve({ argv: ['/bin/sh', '-c', command], env: { ...process.env } })
      },
    )
    setProjectSandboxEnabled(true)
  })

  after(async () => {
    setProjectSandboxEnabled(false)
    mock.restoreAll()
    setGitAvailableForTest(null)
    setGhAvailableForTest(null)
    invalidateGitWorkTreeProbe()
    resetDefaultBranchCache()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('reads branch and status through the read-only overlay', async () => {
    const context = await getPrWorkspaceContext(repo, {
      runGh: () => Promise.resolve({ stdout: '', stderr: '', code: 1 }),
    })
    assert.equal(context.branch, 'main')
    assert.equal(context.hasMergeConflicts, false)
    assert.ok(overlays.length >= 2, `expected sandboxed Git reads, saw ${String(overlays.length)}`)
    for (const overlay of overlays) {
      const filesystem = overlay?.filesystem
      assert.ok(filesystem)
      assert.deepEqual(filesystem.allowWrite, [])
      assert.deepEqual(filesystem.denyWrite, [])
    }
  })
})
