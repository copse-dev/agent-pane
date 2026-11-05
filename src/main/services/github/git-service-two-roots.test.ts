import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  getCommittedChanges,
  getCurrentBranchName,
  getGitChangeStats,
  getGitDiffText,
  getGitLogSinceText,
  getGitStatusText,
  invalidateGitWorkTreeProbe,
  resetDefaultBranchCache,
} from './git-service.ts'
import { buildAdvisorRepoState, buildAdvisorWorkingDiff } from '../advisor-context.ts'
import { setGhAvailableForTest, setGitAvailableForTest } from '../tool-availability.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

const gitOk = spawnSync('git', ['--version']).status === 0

/**
 * #3958: `git-service` no longer defaults a missing root to the agent execution
 * root, whose fallback was the process-global workspace. Every caller names its
 * checkout, so two callers in two checkouts can ask at once and neither sees
 * the other's tree or the window's workspace (pointed at a third repository).
 */
describe('git-service with two roots at once', { skip: !gitOk }, () => {
  const repos = { alpha: '', beta: '', window: '' }
  let restoreWorkspace: (() => void) | undefined

  async function makeRepo(name: string): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), `copse-git-two-roots-${name}-`)))
    const git = (...args: string[]): void => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('config', 'commit.gpgsign', 'false')
    await writeFile(join(root, 'tracked.txt'), 'one\n')
    git('add', 'tracked.txt')
    git('commit', '-qm', 'init')
    // Committed branch work unique to this checkout, then an uncommitted edit.
    git('checkout', '-qb', `${name}-branch`)
    await writeFile(join(root, `${name}-committed.txt`), `${name}\n`)
    git('add', `${name}-committed.txt`)
    git('commit', '-qm', `${name} commit`)
    await writeFile(join(root, 'tracked.txt'), `one\n${name} edit\n`)
    return root
  }

  before(async () => {
    repos.alpha = await makeRepo('alpha')
    repos.beta = await makeRepo('beta')
    repos.window = await makeRepo('window')
    restoreWorkspace = setWorkspaceRootForTest(repos.window)
    setGitAvailableForTest(true)
    setGhAvailableForTest(false)
    invalidateGitWorkTreeProbe()
    resetDefaultBranchCache()
  })

  after(async () => {
    restoreWorkspace?.()
    setGitAvailableForTest(null)
    setGhAvailableForTest(null)
    resetDefaultBranchCache()
    for (const root of Object.values(repos)) await rm(root, { recursive: true, force: true })
  })

  async function readAll(root: string): Promise<{
    branch: string | null
    status: string
    diff: string
    log: string
    stats: { additions: number; deletions: number } | null
    committed: string[] | null
    advisorState: string
    advisorDiff: string
  }> {
    const [branch, status, diff, log, stats, committed, advisorState, advisorDiff] =
      await Promise.all([
        getCurrentBranchName(root),
        getGitStatusText(root),
        getGitDiffText(undefined, false, root),
        getGitLogSinceText(null, 5, root),
        getGitChangeStats(root, { includeCommitted: true, hasOpenPr: async () => false }),
        getCommittedChanges(root, { hasOpenPr: async () => false }),
        buildAdvisorRepoState(root),
        buildAdvisorWorkingDiff(root),
      ])
    return {
      branch,
      status,
      diff,
      log,
      stats,
      committed: committed?.changes.map((change) => change.path) ?? null,
      advisorState,
      advisorDiff,
    }
  }

  it('answers each caller from its own checkout while the window points at a third', async () => {
    const [alpha, beta] = await Promise.all([readAll(repos.alpha), readAll(repos.beta)])

    for (const [name, result] of [
      ['alpha', alpha],
      ['beta', beta],
    ] as const) {
      const other = name === 'alpha' ? 'beta' : 'alpha'
      assert.equal(result.branch, `${name}-branch`)
      assert.match(result.status, /tracked\.txt/)
      assert.match(result.diff, new RegExp(`\\+${name} edit`))
      assert.doesNotMatch(result.diff, new RegExp(`${other}|window`))
      assert.match(result.log, new RegExp(`${name} commit`))
      assert.doesNotMatch(result.log, new RegExp(`${other}|window`))
      // One committed file plus the one-line uncommitted edit.
      assert.deepEqual(result.stats, { additions: 2, deletions: 0 })
      assert.deepEqual(result.committed, [`${name}-committed.txt`])
      assert.match(result.advisorState, new RegExp(`${name}-branch`))
      assert.match(result.advisorDiff, new RegExp(`\\+${name} edit`))
      assert.doesNotMatch(result.advisorDiff, /window/)
    }
  })

  it('reads nothing when the caller has no root, rather than the window workspace', async () => {
    assert.equal(await getCurrentBranchName(null), null)
    assert.equal(await getGitStatusText(null), 'No workspace open.')
    assert.equal(await getGitDiffText(undefined, false, null), 'No workspace open.')
    assert.equal(await getGitLogSinceText(null, 5, null), 'No workspace open.')
    assert.equal(await getGitChangeStats(null), null)
    assert.equal(await getCommittedChanges(null), null)
    assert.equal(await buildAdvisorRepoState(null), '')
  })
})
