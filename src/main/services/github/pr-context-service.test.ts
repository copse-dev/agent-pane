import { describe, it, after, before, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import {
  branchHasOpenPr,
  branchMergedThrough,
  getPrWorkspaceContext,
} from './pr-context-service.ts'
import {
  getCommittedChanges,
  invalidateGitWorkTreeProbe,
  resetDefaultBranchCache,
} from './git-service.ts'
import { branchMergedPrCache } from './branch-pr-cache.ts'
import { invalidateGitHubReadCache } from './backend/github-read-cache.ts'
import type { runGh } from './gh-service.ts'
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

describe('getPrWorkspaceContext with a merged PR', { skip: !gitOk }, () => {
  let repo = ''

  before(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'copse-pr-context-merged-')))
    const git = (...args: string[]): void => {
      spawnSync('git', args, { cwd: repo })
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(join(repo, 'tracked.txt'), 'one\n')
    git('add', 'tracked.txt')
    git('commit', '-qm', 'init')
    git('checkout', '-q', '-b', 'feature')
    await writeFile(join(repo, 'in-pr.ts'), 'export const inPr = true\n')
    git('add', 'in-pr.ts')
    git('commit', '-qm', 'work that was merged')
    setGitAvailableForTest(true)
    setGhAvailableForTest(true)
    invalidateGitWorkTreeProbe()
    resetDefaultBranchCache()
  })

  after(async () => {
    setGitAvailableForTest(null)
    setGhAvailableForTest(null)
    invalidateGitWorkTreeProbe()
    resetDefaultBranchCache()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  const headSha = (): string => {
    const { stdout } = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo })
    return stdout.toString().trim()
  }

  it('stops reporting MERGED-PR work as committed, and stops offering Create PR for it', async () => {
    const sha = headSha()
    const context = await getPrWorkspaceContext(repo, {
      runGh: () =>
        Promise.resolve({
          stdout: JSON.stringify({ state: 'MERGED', headRefOid: sha, number: 4104 }),
          stderr: '',
          code: 0,
        }),
    })
    assert.equal(context.hasOpenPr, false)
    assert.equal(context.canOpenPr, false)
    assert.equal(context.changeStats, null)
  })
})

describe('branchMergedThrough', { skip: !gitOk }, () => {
  let repo = ''
  let mergedSha = ''
  type GhResponse = Awaited<ReturnType<typeof runGh>>

  before(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'copse-branch-merged-through-')))
    const git = (...args: string[]): string => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('config', 'commit.gpgsign', 'false')
    await writeFile(join(repo, 'tracked.txt'), 'one\n')
    git('add', 'tracked.txt')
    git('commit', '-qm', 'init')
    git('checkout', '-q', '-b', 'feature')
    await writeFile(join(repo, 'in-pr.ts'), 'export const inPr = true\n')
    git('add', 'in-pr.ts')
    git('commit', '-qm', 'work that was merged')
    mergedSha = git('rev-parse', 'HEAD')
    setGitAvailableForTest(true)
    invalidateGitWorkTreeProbe()
    resetDefaultBranchCache()
  })

  beforeEach(() => {
    setGhAvailableForTest(true)
    branchMergedPrCache.invalidate()
  })

  after(async () => {
    branchMergedPrCache.invalidate()
    setGitAvailableForTest(null)
    setGhAvailableForTest(null)
    invalidateGitWorkTreeProbe()
    resetDefaultBranchCache()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  /** Fake `gh` that records each request and answers every one the same way. */
  function fakeGh(
    answer: GhResponse | Error,
    requests: Array<{ args: string[]; cwd: string | null }>,
  ): typeof runGh {
    return async (args, options) => {
      requests.push({ args, cwd: options.cwd })
      if (answer instanceof Error) throw answer
      return answer
    }
  }

  const merged = (sha: string, number = 4104): GhResponse => ({
    stdout: JSON.stringify([{ number, headRefOid: sha }]),
    stderr: '',
    code: 0,
  })

  it("answers with the merged PR's recorded head, queried by explicit head", async () => {
    const requests: Array<{ args: string[]; cwd: string | null }> = []
    assert.deepEqual(
      await branchMergedThrough('project', 'feature', repo, fakeGh(merged(mergedSha), requests)),
      { sha: mergedSha, label: 'merged PR #4104' },
    )
    assert.deepEqual(requests, [
      {
        args: [
          'pr',
          'list',
          '--head',
          'feature',
          '--state',
          'merged',
          '--json',
          'number,headRefOid',
          '--limit',
          '1',
        ],
        cwd: repo,
      },
    ])
  })

  const empty: Array<[string, GhResponse]> = [
    ['no merged PR', { stdout: '[]', stderr: '', code: 0 }],
    ['a merged PR without a recorded head', { stdout: '[{"number":7}]', stderr: '', code: 0 }],
  ]
  for (const [name, answer] of empty) {
    it(`answers null for ${name}, and caches that answer`, async () => {
      const requests: Array<{ args: string[]; cwd: string | null }> = []
      const query = fakeGh(answer, requests)
      assert.equal(await branchMergedThrough('project', 'feature', repo, query), null)
      assert.equal(await branchMergedThrough('project', 'feature', repo, query), null)
      assert.equal(requests.length, 1)
    })
  }

  const failures: Array<[string, GhResponse | Error]> = [
    ['a failed gh exit', { stdout: '', stderr: 'authentication failed', code: 1 }],
    ['invalid JSON', { stdout: 'not json', stderr: '', code: 0 }],
    ['a spawn failure', new Error('spawn gh ENOENT')],
  ]
  for (const [name, answer] of failures) {
    it(`answers null for ${name} and backs off until invalidated`, async () => {
      const requests: Array<{ args: string[]; cwd: string | null }> = []
      const query = fakeGh(answer, requests)
      assert.equal(await branchMergedThrough('project', 'feature', repo, query), null)
      assert.equal(await branchMergedThrough('project', 'feature', repo, query), null)
      assert.equal(requests.length, 1, 'a failure is not retried on every read')
      invalidateGitHubReadCache()
      assert.deepEqual(
        await branchMergedThrough('project', 'feature', repo, fakeGh(merged(mergedSha), requests)),
        { sha: mergedSha, label: 'merged PR #4104' },
        'an explicit refresh reads live',
      )
      assert.equal(requests.length, 2)
    })
  }

  it('reuses one observation per project, checkout and branch', async () => {
    const requests: Array<{ args: string[]; cwd: string | null }> = []
    const query = fakeGh(merged(mergedSha), requests)
    await Promise.all([
      branchMergedThrough('project', 'feature', repo, query),
      branchMergedThrough('project', 'feature', repo, query),
    ])
    await branchMergedThrough('project', 'feature', repo, query)
    assert.equal(requests.length, 1)
    await branchMergedThrough('other-project', 'feature', repo, query)
    await branchMergedThrough('project', 'other-branch', repo, query)
    assert.equal(requests.length, 3)
  })

  it('does not spawn without gh, outside a workspace, or for the default branch', async () => {
    const requests: Array<{ args: string[]; cwd: string | null }> = []
    const query = fakeGh(merged(mergedSha), requests)
    assert.equal(await branchMergedThrough('project', 'feature', null, query), null)
    // `--head` matches fork PRs by name alone; a fork's merged `main` must not
    // become the default branch's own base.
    assert.equal(await branchMergedThrough('project', 'main', repo, query), null)
    setGhAvailableForTest(false)
    assert.equal(await branchMergedThrough('project', 'feature', repo, query), null)
    assert.equal(requests.length, 0)
  })

  it("drops a merged PR's files from the Changes panel's committed list", async () => {
    // The committed reads the Changes panel's IPC handlers make, with only the
    // `gh` boundary replaced.
    const hasOpenPr = async (): Promise<boolean> => false
    assert.deepEqual((await getCommittedChanges(repo, { hasOpenPr }))?.changes, [
      { path: 'in-pr.ts', status: 'added' },
    ])
    const query = fakeGh(merged(mergedSha), [])
    const committed = await getCommittedChanges(repo, {
      hasOpenPr,
      mergedThrough: (branch) => branchMergedThrough('project', branch, repo, query),
    })
    assert.ok(committed)
    assert.equal(committed.baseLabel, 'merged PR #4104')
    assert.deepEqual(committed.changes, [])
  })
})
