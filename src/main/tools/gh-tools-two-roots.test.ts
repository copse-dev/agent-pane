import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { getGhPrViewText, getGhRunListText } from '../services/github/gh-service.ts'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from '../services/thread-execution-context.ts'
import { setGhAvailableForTest } from '../services/tool-availability.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { ghPrViewTool, ghRunListTool } from './gh-tools.ts'

const gitOk = spawnSync('git', ['--version']).status === 0

/**
 * A stand-in `gh` that answers from the checkout it was started in: `pr view`
 * returns that checkout's PR as JSON, anything else echoes the PR marker and
 * arguments. It sleeps first so two concurrent calls overlap.
 */
const FAKE_GH = `#!/bin/sh
case "$1" in auth) exit 0 ;; esac
sleep 0.05
n=$(cat .pr-number)
if [ "$1 $2" = "pr view" ]; then
  printf '{"number":%s,"title":"PR %s","url":"https://github.com/o/r/pull/%s","state":"OPEN"}\\n' "$n" "$n" "$n"
else
  printf 'pr=%s args=%s\\n' "$n" "$*"
fi
`

/**
 * #3958: the gh helpers take the checkout and project explicitly, and the
 * gh_* tools pass the running turn's. Two turns in two checkouts may call at
 * once; neither may see the other's checkout or the process-global workspace
 * (pointed at a third repository here).
 */
describe(
  'gh tools with two roots at once',
  { skip: !gitOk || process.platform === 'win32' },
  () => {
    const repos = { alpha: '', beta: '', ambient: '' }
    let fakeBin = ''
    let restoreWorkspace: (() => void) | undefined
    const previousEnv = { PATH: process.env['PATH'], preserve: process.env['COPSE_PRESERVE_PATH'] }

    async function makeRepo(branch: string, prNumber: number): Promise<string> {
      const root = await realpath(await mkdtemp(join(tmpdir(), `copse-gh-two-roots-${branch}-`)))
      const git = (...args: string[]): void => {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
      }
      git('init', '-q', '-b', branch)
      git('config', 'user.name', 'Test')
      git('config', 'user.email', 'test@example.com')
      git('config', 'commit.gpgsign', 'false')
      git('commit', '-q', '--allow-empty', '-m', 'init')
      await writeFile(join(root, '.pr-number'), String(prNumber))
      return root
    }

    function turn(projectId: string, root: string): ThreadExecutionContext {
      return {
        projectId,
        threadId: `thread-${projectId}`,
        projectRoot: root,
        root,
        checkoutMode: 'shared',
        branch: null,
      }
    }

    before(async () => {
      repos.alpha = await makeRepo('alpha', 11)
      repos.beta = await makeRepo('beta', 22)
      repos.ambient = await makeRepo('ambient', 99)
      fakeBin = await mkdtemp(join(tmpdir(), 'copse-fake-gh-'))
      await writeFile(join(fakeBin, 'gh'), FAKE_GH, { mode: 0o755 })
      process.env['PATH'] = `${fakeBin}:${previousEnv.PATH ?? ''}`
      process.env['COPSE_PRESERVE_PATH'] = '1'
      restoreWorkspace = setWorkspaceRootForTest(repos.ambient)
      setGhAvailableForTest(true)
    })

    after(async () => {
      restoreWorkspace?.()
      setGhAvailableForTest(null)
      process.env['PATH'] = previousEnv.PATH
      if (previousEnv.preserve === undefined) delete process.env['COPSE_PRESERVE_PATH']
      else process.env['COPSE_PRESERVE_PATH'] = previousEnv.preserve
      for (const dir of [...Object.values(repos), fakeBin]) {
        if (dir) await rm(dir, { recursive: true, force: true })
      }
    })

    it('getGhRunListText runs gh and reads the branch in the checkout it is given', async () => {
      const opts = { limit: 5 }
      const [alpha, beta] = await Promise.all([
        getGhRunListText(opts, { root: repos.alpha, projectId: null }),
        getGhRunListText(opts, { root: repos.beta, projectId: null }),
      ])
      assert.match(alpha, /^pr=11 args=run list .*--branch alpha$/)
      assert.match(beta, /^pr=22 args=run list .*--branch beta$/)
    })

    it('getGhPrViewText reports provenance only for the project it is given', async () => {
      const opts = { includeChecks: false }
      const [alpha, beta] = await Promise.all([
        getGhPrViewText(opts, { root: repos.alpha, projectId: 'alpha' }),
        getGhPrViewText(opts, { root: repos.beta, projectId: null }),
      ])
      assert.match(alpha, /pull\/11/)
      assert.doesNotMatch(alpha, /no project\/repository context/)
      assert.match(beta, /pull\/22/)
      assert.match(beta, /no project\/repository context/)
    })

    it('the gh_* tools use each running turn’s checkout, not the window workspace', async () => {
      const signal = new AbortController().signal
      const runList = (projectId: string, root: string): Promise<unknown> =>
        runWithThreadExecutionContext(turn(projectId, root), async () =>
          ghRunListTool.execute({ limit: 5, failed_only: false }, signal),
        )
      const view = (projectId: string, root: string): Promise<unknown> =>
        runWithThreadExecutionContext(turn(projectId, root), async () =>
          ghPrViewTool.execute({ include_checks: false }, signal),
        )
      const [alphaRuns, betaRuns, alphaView, betaView] = await Promise.all([
        runList('alpha', repos.alpha),
        runList('beta', repos.beta),
        view('alpha', repos.alpha),
        view('beta', repos.beta),
      ])
      assert.match(String(alphaRuns), /^pr=11 args=run list .*--branch alpha$/)
      assert.match(String(betaRuns), /^pr=22 args=run list .*--branch beta$/)
      assert.match(String(alphaView), /pull\/11/)
      assert.match(String(betaView), /pull\/22/)
      for (const text of [alphaView, betaView]) {
        assert.doesNotMatch(String(text), /no project\/repository context/)
      }
    })
  },
)
