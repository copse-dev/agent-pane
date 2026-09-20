import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gitCommitTool } from './git-tools.ts'
import { setApprovalHandler } from '../services/approval.ts'
import { clearDiffQueueForTest } from '../services/diff-queue.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { setGitAvailableForTest } from '../services/tool-availability.ts'
import { setSetting } from '../services/storage/settings.ts'
import {
  clearWorkspaceTrustForTest,
  setWorkspaceTrusted,
} from '../services/security/workspace-trust.ts'
import { runWithThreadExecutionContext } from '../services/thread-execution-context.ts'
import {
  initProjectSandbox,
  isProjectSandboxEnabled,
  shutdownProjectSandbox,
} from '../project-sandbox/index.ts'

describe('git_commit configured helpers', () => {
  const cleanups: Array<() => void | Promise<void>> = []
  const signal = new AbortController().signal

  async function commit(repo: string, message: string, stageAll: boolean): Promise<unknown> {
    return runWithThreadExecutionContext(
      {
        projectId: 'git-commit-test',
        threadId: 'commit-thread',
        projectRoot: repo,
        root: repo,
        checkoutMode: 'shared',
        branch: 'main',
      },
      async () => gitCommitTool.execute({ message, stage_all: stageAll }, signal),
    )
  }

  afterEach(async () => {
    await shutdownProjectSandbox()
    setApprovalHandler(null)
    setGitAvailableForTest(null)
    clearDiffQueueForTest()
    clearWorkspaceTrustForTest()
    await setSetting('trustedShellCommands', [])
    await setSetting('safetyClassifierEnabled', true)
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  async function fixture(): Promise<{
    repo: string
    hooks: string
    git: (...args: string[]) => string
  }> {
    const repo = await realpath(await mkdtemp(join(tmpdir(), 'copse-commit-helpers-')))
    cleanups.push(async () => rm(repo, { recursive: true, force: true }))
    cleanups.push(setWorkspaceRootForTest(repo))
    setGitAvailableForTest(true)
    await setSetting('safetyClassifierEnabled', false)
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Copse Test')
    git('config', 'user.email', 'copse@example.invalid')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.fsmonitor', 'false')
    const hooks = join(repo, 'hooks')
    await mkdir(hooks)
    git('config', 'core.hooksPath', hooks)
    await writeFile(join(repo, 'tracked.txt'), 'initial\n')
    git('add', 'tracked.txt')
    git('commit', '-qm', 'initial')
    await writeFile(join(repo, 'tracked.txt'), 'changed\n')
    return { repo, hooks, git }
  }

  it('requests approval without a sandbox and rejects before staging or running hooks', async () => {
    const { repo, hooks, git } = await fixture()
    setWorkspaceTrusted(repo, true)
    await setSetting('trustedShellCommands', ['git'])
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\ntouch hook-ran\n', { mode: 0o700 })
    let prompt = ''
    setApprovalHandler(async (request) => {
      prompt = request.body
      assert.notEqual(request.allowRemember, true, 'a native commit never remembers a host escape')
      return { approved: false, remember: false }
    })
    const result = await commit(repo, 'Requested commit', true)
    assert.equal(result, 'User rejected git commit.')
    assert.match(prompt, /git add -A && git commit -m/)
    assert.equal(git('diff', '--cached'), '')
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1')
    assert.equal(existsSync(join(repo, 'hook-ran')), false)
  })

  it('honors approved hooks and safely quotes the attributed commit message', async () => {
    const { repo, hooks, git } = await fixture()
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\nprintf ran > hook-ran\n', {
      mode: 0o700,
    })
    let prompts = 0
    setApprovalHandler(async () => {
      prompts++
      return { approved: true, remember: false }
    })
    const message = "Preserve 'quotes' and $(touch injected); `touch injected`\n\nA body."
    await commit(repo, message, true)
    assert.equal(prompts, 1)
    assert.equal(await readFile(join(repo, 'hook-ran'), 'utf8'), 'ran')
    assert.equal(existsSync(join(repo, 'injected')), false)
    const committedMessage = git('log', '-1', '--format=%B')
    assert.ok(committedMessage.startsWith(message))
    assert.match(committedMessage, /Co-Authored-By: Copse/)
  })

  it('surfaces signing failure instead of producing an unsigned commit', async () => {
    const { repo, git } = await fixture()
    const signer = join(repo, 'failing-signer')
    await writeFile(signer, '#!/bin/sh\nprintf ran > signer-ran\nexit 1\n', { mode: 0o700 })
    git('config', 'commit.gpgSign', 'true')
    git('config', 'gpg.format', 'openpgp')
    git('config', 'gpg.openpgp.program', signer)
    git('config', 'gpg.program', signer)
    git('config', 'user.signingkey', 'test-key')
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    await assert.rejects(() => commit(repo, 'Must be signed', true))
    assert.equal(await readFile(join(repo, 'signer-ran'), 'utf8'), 'ran')
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1')
  })

  it('runs hooks and signs with a workspace key inside the real macOS sandbox', async (t) => {
    if (process.platform !== 'darwin') {
      t.skip('macOS seatbelt integration')
      return
    }
    const { repo, hooks, git } = await fixture()
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\nprintf ran > hook-ran\n', {
      mode: 0o700,
    })
    // A disposable fixture key, never a developer's keychain/agent/private key.
    const key = join(repo, 'test-signing-key')
    execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
    git('config', 'commit.gpgSign', 'true')
    git('config', 'gpg.format', 'ssh')
    git('config', 'gpg.ssh.program', '/usr/bin/ssh-keygen')
    git('config', 'user.signingkey', key)
    git('add', 'tracked.txt')
    await initProjectSandbox()
    if (!isProjectSandboxEnabled()) {
      t.skip('ASRT sandbox unavailable')
      return
    }
    let prompts = 0
    setApprovalHandler(async () => {
      prompts++
      return { approved: false, remember: false }
    })
    await commit(repo, 'Signed inside sandbox', false)
    assert.equal(prompts, 0, 'must succeed without an unsandboxed retry')
    assert.equal(await readFile(join(repo, 'hook-ran'), 'utf8'), 'ran')
    assert.match(git('cat-file', 'commit', 'HEAD'), /gpgsig -----BEGIN SSH SIGNATURE-----/)
  })

  it('does not silently let a failing hook escape the sandbox', async (t) => {
    if (process.platform !== 'darwin') {
      t.skip('macOS seatbelt integration')
      return
    }
    const { repo, hooks, git } = await fixture()
    setWorkspaceTrusted(repo, true)
    await setSetting('trustedShellCommands', ['git'])
    const outside = await realpath(await mkdtemp(join(dirname(repo), 'copse-hook-outside-')))
    cleanups.push(async () => rm(outside, { recursive: true, force: true }))
    const marker = join(outside, 'marker')
    await writeFile(join(hooks, 'pre-commit'), `#!/bin/sh\nprintf blocked > '${marker}'\n`, {
      mode: 0o700,
    })
    git('add', 'tracked.txt')
    await initProjectSandbox()
    if (!isProjectSandboxEnabled()) {
      t.skip('ASRT sandbox unavailable')
      return
    }
    let prompts = 0
    setApprovalHandler(async () => {
      prompts++
      return { approved: false, remember: false }
    })
    await assert.rejects(() => commit(repo, 'Blocked hook', false), /Operation not permitted/)
    assert.equal(prompts, 0)
    assert.equal(existsSync(marker), false)
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1')
  })
})
