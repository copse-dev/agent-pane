import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { runCheckup } from './checkup.ts'
import { setGitAvailableForTest } from '../tool-availability.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

const gitOk = spawnSync('git', ['--version']).status === 0

/**
 * #3958: the checkup reports the asking turn's own roots. Two turns in two
 * checkouts run it at once while the window-global workspace points at a
 * third, and each report names only its own project and branch.
 */
describe('runCheckup with two roots at once', { skip: !gitOk }, () => {
  const repos = { alpha: '', beta: '', window: '' }
  let restoreWorkspace: (() => void) | undefined

  async function makeRepo(name: string): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), `copse-checkup-${name}-`)))
    const git = (...args: string[]): void => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    git('init', '-q', '-b', `${name}-branch`)
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '--no-gpg-sign',
      '-m',
      'init',
    )
    return root
  }

  before(async () => {
    repos.alpha = await makeRepo('alpha')
    repos.beta = await makeRepo('beta')
    repos.window = await makeRepo('window')
    restoreWorkspace = setWorkspaceRootForTest(repos.window)
    setGitAvailableForTest(true)
  })

  after(async () => {
    restoreWorkspace?.()
    setGitAvailableForTest(null)
    for (const root of Object.values(repos)) await rm(root, { recursive: true, force: true })
  })

  const workspaceDetail = async (root: string | null): Promise<string> => {
    const report = await runCheckup({ projectRoot: root, executionRoot: root })
    return report.checks.map((check) => check.detail).join('\n')
  }

  it("names each turn's own project and branch, never the window workspace", async () => {
    const [alpha, beta] = await Promise.all([
      workspaceDetail(repos.alpha),
      workspaceDetail(repos.beta),
    ])
    assert.match(alpha, new RegExp(`${repos.alpha} — .*git branch alpha-branch`))
    assert.match(beta, new RegExp(`${repos.beta} — .*git branch beta-branch`))
    for (const detail of [alpha, beta]) {
      assert.doesNotMatch(detail, /window/)
    }
  })
})
