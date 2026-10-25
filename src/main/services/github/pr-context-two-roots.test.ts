import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { FollowUpContext } from '@shared/follow-ups/types.ts'
import type { runGh } from './gh-service.ts'
import { getGitBranchStatus, getPrWorkspaceContext } from './pr-context-service.ts'
import { branchPrCache } from './branch-pr-cache.ts'
import { invalidateGitWorkTreeProbe, resetDefaultBranchCache } from './git-service.ts'
import { suggestFollowUps } from '../follow-up-service.ts'
import { describeChanges } from '../pr-body-service.ts'
import { setGhAvailableForTest, setGitAvailableForTest } from '../tool-availability.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

const gitOk = spawnSync('git', ['--version']).status === 0

/**
 * #3958: these services take the checkout as an explicit root. Two threads in
 * two checkouts can ask at once, and neither may see the other's checkout or
 * the process-global workspace (pointed at a third repository here).
 */
describe('PR context services with two roots at once', { skip: !gitOk }, () => {
  const repos = { alpha: '', beta: '', ambient: '' }
  let restoreWorkspace: (() => void) | undefined
  let previousMockLlm: string | undefined

  async function makeRepo(branch: string, uncommitted: string): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), `copse-two-roots-${branch}-`)))
    const git = (...args: string[]): void => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    git('init', '-q', '-b', branch)
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('config', 'commit.gpgsign', 'false')
    await writeFile(join(root, 'tracked.txt'), 'one\n')
    git('add', 'tracked.txt')
    git('commit', '-qm', 'init')
    if (uncommitted) await writeFile(join(root, 'tracked.txt'), uncommitted)
    return root
  }

  /** Fake `gh` that answers with the PR number for whichever checkout asked. */
  function ghByRoot(prs: Record<string, number>, seen: string[]): typeof runGh {
    return async (_args, options) => {
      const cwd = options?.cwd ?? '(none)'
      seen.push(cwd)
      // Yield so the two lookups interleave rather than run back to back.
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      const number = prs[cwd]
      if (number === undefined) return { stdout: '', stderr: 'unknown root', code: 1 }
      return {
        stdout: JSON.stringify([
          { number, title: `PR ${String(number)}`, url: `https://example.test/${String(number)}` },
        ]),
        stderr: '',
        code: 0,
      }
    }
  }

  before(async () => {
    repos.alpha = await makeRepo('alpha', 'one\nalpha\n')
    repos.beta = await makeRepo('beta', 'beta\nbeta\nbeta\n')
    repos.ambient = await makeRepo('ambient', '')
    restoreWorkspace = setWorkspaceRootForTest(repos.ambient)
    previousMockLlm = process.env['COPSE_PANEL_MOCK_LLM']
    // No model: follow-ups fall back to their deterministic git/PR bubbles.
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    setGitAvailableForTest(true)
    invalidateGitWorkTreeProbe()
    resetDefaultBranchCache()
    branchPrCache.invalidate()
  })

  after(async () => {
    restoreWorkspace?.()
    if (previousMockLlm === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
    else process.env['COPSE_PANEL_MOCK_LLM'] = previousMockLlm
    setGitAvailableForTest(null)
    setGhAvailableForTest(null)
    invalidateGitWorkTreeProbe()
    resetDefaultBranchCache()
    branchPrCache.invalidate()
    for (const root of Object.values(repos)) {
      if (root) await rm(root, { recursive: true, force: true })
    }
  })

  it('getPrWorkspaceContext reads each checkout it is given', async () => {
    setGhAvailableForTest(false)
    const seen: string[] = []
    const runGh = ghByRoot({}, seen)
    const [alpha, beta] = await Promise.all([
      getPrWorkspaceContext(repos.alpha, { runGh }),
      getPrWorkspaceContext(repos.beta, { runGh }),
    ])
    assert.equal(alpha.branch, 'alpha')
    assert.deepEqual(alpha.changeStats, { additions: 1, deletions: 0 })
    assert.equal(beta.branch, 'beta')
    assert.deepEqual(beta.changeStats, { additions: 3, deletions: 1 })
    assert.deepEqual(seen.toSorted(), [repos.alpha, repos.beta].toSorted())
  })

  it('getGitBranchStatus reads each checkout it is given', async () => {
    setGhAvailableForTest(true)
    const seen: string[] = []
    const runGh = ghByRoot({ [repos.alpha]: 11, [repos.beta]: 22 }, seen)
    const [alpha, beta] = await Promise.all([
      getGitBranchStatus('project', undefined, repos.alpha, { runGh }),
      getGitBranchStatus('project', undefined, repos.beta, { runGh }),
    ])
    assert.equal(alpha.currentBranch, 'alpha')
    assert.equal(alpha.pr?.number, 11)
    assert.equal(beta.currentBranch, 'beta')
    assert.equal(beta.pr?.number, 22)
    assert.deepEqual(seen.toSorted(), [repos.alpha, repos.beta].toSorted())
  })

  it('suggestFollowUps builds the Changes chip from each checkout', async () => {
    setGhAvailableForTest(false)
    const context: FollowUpContext = {
      userMessage: 'Edit tracked.txt',
      assistantMessage: 'Done.',
      toolNames: [],
    }
    const [alpha, beta] = await Promise.all([
      suggestFollowUps(context, repos.alpha),
      suggestFollowUps(context, repos.beta),
    ])
    const changes = (suggestions: typeof alpha): (typeof alpha)[number] | undefined =>
      suggestions.find((suggestion) => suggestion.variant === 'changes')
    assert.equal(changes(alpha)?.additions, 1)
    assert.equal(changes(alpha)?.deletions, 0)
    assert.equal(changes(beta)?.additions, 3)
    assert.equal(changes(beta)?.deletions, 1)
  })

  it('suggestPrBody describes each checkout it is given', async () => {
    const [alpha, beta] = await Promise.all([
      describeChanges(repos.alpha),
      describeChanges(repos.beta),
    ])
    assert.match(alpha, /^Uncommitted: \+1 -0$/m)
    assert.match(beta, /^Uncommitted: \+3 -1$/m)
  })
})
