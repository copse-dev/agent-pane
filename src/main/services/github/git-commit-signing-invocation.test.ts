import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setSetting } from '../storage/settings.ts'
import { setApprovalHandler } from '../approval.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setGitAvailableForTest } from '../tool-availability.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { gitCommitTool } from '../../tools/git-tools.ts'
import {
  initProjectSandbox,
  isProjectSandboxEnabled,
  shutdownProjectSandbox,
} from '../../project-sandbox/index.ts'
import { isGitCommitPayload, leaseGitSigningBroker } from '../security/git-signing-broker.ts'

const validCommit = Buffer.from(
  `tree ${'a'.repeat(40)}\nauthor A <a@example.invalid> 1 +0000\ncommitter A <a@example.invalid> 1 +0000\n\nCommit\n`,
)

describe('Git signing broker input', () => {
  it('accepts commit objects and refuses arbitrary agent messages, tags, and oversized input', () => {
    assert.equal(isGitCommitPayload(validCommit), true)
    for (const payload of [
      Buffer.from('please sign my SSH login'),
      Buffer.from([0, 0, 0, 1, 11]),
      Buffer.from('object ' + 'a'.repeat(40) + '\ntype commit\n'),
      Buffer.alloc(1024 * 1024 + 1),
      Buffer.concat([validCommit, Buffer.from([0])]),
    ]) {
      assert.equal(isGitCommitPayload(payload), false)
    }
  })
  it('offers no helper capability without an active sandbox', async () => {
    await setSetting('gitCommitSshAgentSocketAccess', true)
    assert.equal(await leaseGitSigningBroker(process.cwd()), null)
    await setSetting('gitCommitSshAgentSocketAccess', false)
  })
})

describe('isolated SSH commit signing', { skip: process.platform !== 'darwin' }, () => {
  const cleanups: Array<() => void | Promise<void>> = []
  let agent: ChildProcess | undefined
  const originalSocket = process.env['SSH_AUTH_SOCK']

  afterEach(async () => {
    await shutdownProjectSandbox()
    setApprovalHandler(null)
    setGitAvailableForTest(null)
    await setSetting('gitCommitSshAgentSocketAccess', false)
    await setSetting('autoRunSandboxCommands', true)
    await setSetting('toolPermissionOverrides', {})
    if (agent) {
      const child = agent
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child.once('exit', () => {
            resolve()
          })
          child.kill()
        })
      }
      agent = undefined
    }
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    if (originalSocket === undefined) delete process.env['SSH_AUTH_SOCK']
    else process.env['SSH_AUTH_SOCK'] = originalSocket
  })

  async function fixture(t: { skip: (message?: string) => void }): Promise<{
    repo: string
    secrets: string
    git: (...args: string[]) => string
    commit: () => Promise<unknown>
  } | null> {
    await initProjectSandbox()
    if (!isProjectSandboxEnabled()) {
      t.skip('ASRT sandbox unavailable')
      return null
    }
    const directory = await mkdtemp('/private/tmp/copse-sign-test-')
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const repo = join(directory, 'repo')
    const secrets = join(directory, 'secrets')
    await mkdir(repo)
    await mkdir(secrets)
    cleanups.push(setWorkspaceRootForTest(repo))
    setGitAvailableForTest(true)
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Signing Test')
    git('config', 'user.email', 'sign@example.invalid')
    git('config', 'core.fsmonitor', 'false')
    git(
      '-c',
      'commit.gpgSign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--allow-empty',
      '-qm',
      'initial',
    )
    const key = join(secrets, 'key')
    execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
    const socketPath = join(secrets, 'agent.sock')
    agent = spawn('/usr/bin/ssh-agent', ['-D', '-a', socketPath], { stdio: 'ignore' })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await stat(socketPath).then(
          (s) => s.isSocket(),
          () => false,
        )
      )
        break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    process.env['SSH_AUTH_SOCK'] = socketPath
    execFileSync('/usr/bin/ssh-add', [key], {
      env: { ...process.env, SSH_AUTH_SOCK: socketPath },
      stdio: 'ignore',
    })
    git('config', 'commit.gpgSign', 'true')
    git('config', 'gpg.format', 'ssh')
    git('config', 'gpg.ssh.program', '/usr/bin/ssh-keygen')
    git('config', 'user.signingkey', key)
    await writeFile(join(repo, 'change.txt'), 'pending\n')
    git('add', 'change.txt')
    await setSetting('gitCommitSshAgentSocketAccess', true)
    await setSetting('autoRunSandboxCommands', true)
    const commit = (): Promise<unknown> =>
      runWithThreadExecutionContext(
        {
          projectId: 'sign-test',
          threadId: 'sign-thread',
          projectRoot: repo,
          root: repo,
          checkoutMode: 'shared',
          branch: 'main',
        },
        async () =>
          gitCommitTool.execute(
            { message: 'Signed fixture', stage_all: false },
            new AbortController().signal,
          ),
      )
    return { repo, secrets, git, commit }
  }

  it('signs with the approved key while hooks cannot access the agent or private key', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { repo, secrets, git, commit } = setup
    const hooks = join(repo, 'hooks')
    await mkdir(hooks)
    await writeFile(
      join(hooks, 'pre-commit'),
      `#!/bin/sh\n/usr/bin/ssh-add -l > hook-output 2>&1\necho $? > hook-status\ncat '${join(secrets, 'key')}' > leaked-key 2>/dev/null\nexit 0\n`,
      { mode: 0o700 },
    )
    git('config', 'core.hooksPath', hooks)
    let prompts = 0
    setApprovalHandler(async (request) => {
      prompts++
      assert.equal(request.title, 'Allow this Git signing helper?')
      assert.match(request.body, /Key: SHA256:/)
      assert.match(request.body, /ssh-keygen -Y sign -n git -U/)
      return { approved: true, remember: true }
    })
    await commit()
    assert.equal(prompts, 1)
    assert.notEqual((await readFile(join(repo, 'hook-status'), 'utf8')).trim(), '0')
    assert.equal((await readFile(join(repo, 'leaked-key'))).length, 0)
    assert.match(git('cat-file', 'commit', 'HEAD'), /gpgsig -----BEGIN SSH SIGNATURE-----/)
    const publicKey = await readFile(join(secrets, 'key.pub'), 'utf8')
    const allowed = join(secrets, 'allowed-signers')
    await writeFile(allowed, `sign@example.invalid ${publicKey}`)
    git('-c', `gpg.ssh.allowedSignersFile=${allowed}`, 'verify-commit', 'HEAD')
    await writeFile(join(repo, 'change.txt'), 'second\n')
    git('add', 'change.txt')
    await commit()
    assert.equal(prompts, 1, 'unchanged project/helper/key/socket uses the exact grant')
    const copiedKey = join(secrets, 'different-config')
    await writeFile(`${copiedKey}.pub`, publicKey)
    git('config', 'user.signingKey', copiedKey)
    await writeFile(join(repo, 'change.txt'), 'third\n')
    git('add', 'change.txt')
    await commit()
    assert.equal(prompts, 2, 'changed configuration needs fresh approval')
    await setSetting('toolPermissionOverrides', { 'copse:git_commit': 'ask' })
    setApprovalHandler(async (request) => {
      prompts++
      assert.equal(request.allowRemember, false)
      return { approved: true, remember: true }
    })
    await writeFile(join(repo, 'change.txt'), 'fourth\n')
    git('add', 'change.txt')
    await commit()
    assert.equal(prompts, 3, 'Always ask ignores a remembered helper grant')
  })

  it('declines before hooks or a signed/unsigned commit and does not remember rejection', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { repo, git, commit } = setup
    const hooks = join(repo, 'hooks')
    await mkdir(hooks)
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\ntouch hook-ran\n', { mode: 0o700 })
    git('config', 'core.hooksPath', hooks)
    let prompts = 0
    setApprovalHandler(async () => {
      prompts++
      return { approved: false, remember: true }
    })
    await assert.rejects(commit, /User rejected SSH commit signing/)
    await assert.rejects(commit, /User rejected SSH commit signing/)
    assert.equal(prompts, 2)
    assert.equal(existsSync(join(repo, 'hook-ran')), false)
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1')
  })

  it('pins approved signing configuration against changes while the prompt is open', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { repo, git, commit } = setup
    const evil = join(repo, 'replacement-signer')
    await writeFile(evil, '#!/bin/sh\ntouch replacement-ran\nexit 1\n', { mode: 0o700 })
    setApprovalHandler(async () => {
      git('config', 'gpg.ssh.program', evil)
      return { approved: true, remember: true }
    })
    await commit()
    assert.equal(existsSync(join(repo, 'replacement-ran')), false)
    assert.match(git('cat-file', 'commit', 'HEAD'), /gpgsig -----BEGIN SSH SIGNATURE-----/)
    // A newly configured custom signer never inherits the system signer's socket.
    assert.equal(await leaseGitSigningBroker(repo), null)
  })

  it('will not turn a custom signer or forged denial text into a socket grant', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { repo, git, commit } = setup
    const custom = join(repo, 'custom-signer')
    await writeFile(custom, '#!/bin/sh\necho "Operation not permitted" >&2\nexit 1\n', {
      mode: 0o700,
    })
    git('config', 'gpg.ssh.program', custom)
    let prompts = 0
    setApprovalHandler(async () => {
      prompts++
      return { approved: true, remember: true }
    })
    await assert.rejects(commit)
    assert.equal(prompts, 0)
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1')
  })
})
