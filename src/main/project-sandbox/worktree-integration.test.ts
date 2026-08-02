import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterSandboxedCommand,
  initProjectSandbox,
  isProjectSandboxEnabled,
  shutdownProjectSandbox,
  spawnInProjectSandbox,
} from './index.ts'
import {
  clearAllowedWorkspaceRootsForTest,
  registerInternalWorkspaceRoot,
} from '../services/workspace.ts'
import { getGitStatus } from '../services/github/git-service.ts'
import { setGitAvailableForTest } from '../services/tool-availability.ts'

interface CommandResult {
  stdout: string
  stderr: string
  code: number
}

const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Copse Test',
  GIT_AUTHOR_EMAIL: 'copse@example.invalid',
  GIT_COMMITTER_NAME: 'Copse Test',
  GIT_COMMITTER_EMAIL: 'copse@example.invalid',
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: gitEnv })
}

async function runSandboxed(
  executable: string,
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  const child = await spawnInProjectSandbox(executable, args, {
    cwd,
    env: gitEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf-8')
  child.stderr?.setEncoding('utf-8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode) => {
      resolve(exitCode ?? 1)
    })
  })
  afterSandboxedCommand()
  return { stdout, stderr, code }
}

describe('linked-worktree sandbox integration', () => {
  const cleanups: string[] = []

  afterEach(async () => {
    await shutdownProjectSandbox()
    setGitAvailableForTest(null)
    clearAllowedWorkspaceRootsForTest()
    for (const path of cleanups.splice(0).reverse()) {
      await rm(path, { recursive: true, force: true })
    }
  })

  it('supports Git from a nested project root without exposing hooks, config, or siblings', async (t) => {
    if (process.platform === 'win32') {
      t.skip('project sandbox integration is not enabled on Windows')
      return
    }

    const root = await mkdtemp(join(tmpdir(), 'copse-worktree-sandbox-'))
    cleanups.push(root)
    const repo = join(root, 'repo')
    const worktree = join(root, 'thread')
    const sibling = join(root, 'sibling')
    const nested = join(worktree, 'packages', 'app')
    await mkdir(join(repo, 'packages', 'app'), { recursive: true })
    git(repo, ['init', '-q', '-b', 'main'])
    await writeFile(join(repo, 'packages', 'app', 'tracked.txt'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'initial'])
    git(repo, ['worktree', 'add', '-q', '-b', 'thread-a', worktree])
    git(repo, ['worktree', 'add', '-q', '-b', 'thread-b', sibling])
    await writeFile(join(sibling, 'sibling-only.txt'), 'secret\n')

    const registration = await registerInternalWorkspaceRoot(worktree, nested)
    setGitAvailableForTest(true)
    await initProjectSandbox()
    if (!isProjectSandboxEnabled()) {
      t.skip('ASRT sandbox unavailable')
      return
    }

    const status = await runSandboxed('git', ['status', '--short'], nested)
    assert.equal(status.code, 0, status.stderr)
    const productStatus = await getGitStatus(nested)
    assert.deepEqual(productStatus, { staged: [], unstaged: [] })
    await writeFile(join(nested, 'tracked.txt'), 'changed\n')
    await writeFile(join(nested, 'new.txt'), 'new\n')
    assert.match((await runSandboxed('git', ['diff', '--', '.'], nested)).stdout, /changed/)
    const add = await runSandboxed('git', ['add', 'tracked.txt', 'new.txt'], nested)
    assert.equal(add.code, 0, add.stderr)
    const commit = await runSandboxed('git', ['commit', '-q', '-m', 'sandbox commit'], nested)
    assert.equal(commit.code, 0, commit.stderr)

    const configWrite = await runSandboxed('git', ['config', 'copse.sandbox-test', 'true'], nested)
    assert.notEqual(configWrite.code, 0)
    assert.throws(() => git(repo, ['config', '--get', 'copse.sandbox-test']))

    const hookPath = join(registration.commonGitDir, 'hooks', 'pre-commit')
    const writeHook = await runSandboxed(
      process.execPath,
      ['-e', 'require("node:fs").writeFileSync(process.argv[1], "blocked")', hookPath],
      nested,
    )
    assert.notEqual(writeHook.code, 0)
    assert.equal(existsSync(hookPath), false)

    const readSibling = await runSandboxed(
      process.execPath,
      [
        '-e',
        'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))',
        join(sibling, 'sibling-only.txt'),
      ],
      nested,
    )
    assert.notEqual(readSibling.code, 0)
    assert.equal(readSibling.stdout, '')

    // Bug fix: the sandbox must also deny reads of the shared primary
    // checkout. Before the fix, `denyRead` only listed `[homedir(), ...siblings]`
    // and the primary tree — living under `/tmp` in this test — was
    // ASRT-default-allowed, so a worktree agent could read the whole main
    // project through this exact path.
    await writeFile(join(repo, 'primary-only.txt'), 'primary secret\n')
    const readPrimary = await runSandboxed(
      process.execPath,
      [
        '-e',
        'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))',
        join(repo, 'primary-only.txt'),
      ],
      nested,
    )
    assert.notEqual(readPrimary.code, 0)
    assert.equal(readPrimary.stdout, '')

    // Sibling packages under the same worktree checkout must also be denied
    // when the execution root is nested (packages/app), while the agent's
    // own execution root remains readable via the more-specific allow.
    await mkdir(join(worktree, 'packages', 'other'), { recursive: true })
    await writeFile(join(worktree, 'packages', 'other', 'peer.txt'), 'sibling pkg\n')
    const readSiblingPkg = await runSandboxed(
      process.execPath,
      [
        '-e',
        'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))',
        join(worktree, 'packages', 'other', 'peer.txt'),
      ],
      nested,
    )
    assert.notEqual(readSiblingPkg.code, 0)
    assert.equal(readSiblingPkg.stdout, '')
  })
})
