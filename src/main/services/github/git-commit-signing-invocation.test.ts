import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { setSetting } from '../storage/settings.ts'
import { setApprovalHandler } from '../approval.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setGitAvailableForTest } from '../tool-availability.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { gitCommitTool } from '../../tools/git-tools.ts'
import { runCommand } from '../exec/command-runner.ts'
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
    await setSetting('gitCommitSshAgentSocketAccess', true)
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
    commit: (stageAll?: boolean) => Promise<unknown>
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
    const commit = (stageAll = false): Promise<unknown> =>
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
            { message: 'Signed fixture', stage_all: stageAll },
            new AbortController().signal,
          ),
      )
    return { repo, secrets, git, commit }
  }

  it('signs without asking by default while hooks cannot access the agent or private key', async (t) => {
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
    setApprovalHandler(async () => {
      prompts++
      return { approved: false, remember: false }
    })
    await commit()
    assert.equal(prompts, 0, 'the default-on setting signs without asking')
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
    assert.equal(prompts, 0, 'unchanged project/helper/key/socket reuses the cached grant')
    const copiedKey = join(secrets, 'different-config')
    await writeFile(`${copiedKey}.pub`, publicKey)
    git('config', 'user.signingKey', copiedKey)
    await writeFile(join(repo, 'change.txt'), 'third\n')
    git('add', 'change.txt')
    await commit()
    assert.equal(prompts, 0, 'changed configuration is re-granted without asking')
    await setSetting('toolPermissionOverrides', { 'copse:git_commit': 'ask' })
    setApprovalHandler(async (request) => {
      prompts++
      assert.equal(request.title, 'Allow this Git signing helper?')
      assert.match(request.body, /Key: SHA256:/)
      assert.match(request.body, /ssh-keygen -Y sign -n git -U/)
      assert.equal(request.allowRemember, false)
      return { approved: true, remember: true }
    })
    await writeFile(join(repo, 'change.txt'), 'fourth\n')
    git('add', 'change.txt')
    await commit()
    assert.equal(prompts, 1, 'Always ask forces a fresh prompt and ignores the cached grant')
    await writeFile(join(repo, 'change.txt'), 'fifth\n')
    git('add', 'change.txt')
    await commit()
    assert.equal(prompts, 2, 'Always ask never remembers the helper grant')
  })

  it('keeps a relative configured private key inside the workspace unreadable to hooks', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { repo, secrets, git, commit } = setup
    const key = join(repo, 'commit-key')
    await writeFile(key, await readFile(join(secrets, 'key')), { mode: 0o600 })
    await writeFile(`${key}.pub`, await readFile(join(secrets, 'key.pub')))
    git('config', 'user.signingKey', './commit-key.pub')
    const hooks = join(repo, 'hooks')
    await mkdir(hooks)
    await writeFile(
      join(hooks, 'pre-commit'),
      '#!/bin/sh\ncat commit-key > leaked-key 2>/dev/null\nexit 0\n',
      { mode: 0o700 },
    )
    git('config', 'core.hooksPath', hooks)
    let prompts = 0
    setApprovalHandler(async () => {
      prompts++
      return { approved: false, remember: false }
    })
    await commit()
    assert.equal(prompts, 0)
    assert.equal((await readFile(join(repo, 'leaked-key'))).length, 0)
    assert.match(git('cat-file', 'commit', 'HEAD'), /gpgsig -----BEGIN SSH SIGNATURE-----/)
  })

  it('reports a missing agent key without retrying unsigned or reading the private key', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { secrets, git, commit } = setup
    const publicKey = await readFile(join(secrets, 'key.pub'), 'utf8')
    git('config', 'user.signingKey', `key::${publicKey.trim()}`)
    execFileSync('/usr/bin/ssh-add', ['-D'], { stdio: 'ignore' })
    const before = git('rev-parse', 'HEAD')
    let prompts = 0
    setApprovalHandler(async () => {
      prompts++
      return { approved: false, remember: false }
    })
    await assert.rejects(commit, /not loaded in ssh-agent/)
    assert.equal(git('rev-parse', 'HEAD'), before, 'a signing failure must not create a commit')
    assert.equal(prompts, 0, 'an agent failure must not request private-key access')
    execFileSync('/usr/bin/ssh-add', [join(secrets, 'key')], { stdio: 'ignore' })
    await commit()
    assert.match(git('cat-file', 'commit', 'HEAD'), /gpgsig -----BEGIN SSH SIGNATURE-----/)
    assert.equal(prompts, 0)
  })

  it('offers one-commit private-key consent before staging when the default-on agent has no key', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { repo, secrets, git, commit } = setup
    git('config', 'user.signingKey', join(secrets, 'key.pub'))
    execFileSync('/usr/bin/ssh-add', ['-D'], { stdio: 'ignore' })
    git('restore', '--staged', 'change.txt')
    const hooks = join(repo, 'hooks')
    await mkdir(hooks)
    await writeFile(
      join(hooks, 'pre-commit'),
      `#!/bin/sh\ntouch hook-ran\ncat '${join(secrets, 'key')}' > leaked-key 2>/dev/null\nexit 0\n`,
      { mode: 0o700 },
    )
    git('config', 'core.hooksPath', hooks)
    let prompts = 0
    setApprovalHandler(async (request) => {
      prompts++
      assert.equal(request.title, 'Allow reading this Git signing key?')
      assert.equal(request.allowRemember, false)
      assert.equal(git('diff', '--cached'), '')
      assert.equal(existsSync(join(repo, 'hook-ran')), false)
      return { approved: prompts > 1, remember: true }
    })
    await assert.rejects(() => commit(true), /User rejected reading the SSH signing key/)
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1')
    await commit(true)
    assert.equal(prompts, 2)
    assert.equal((await readFile(join(repo, 'leaked-key'))).length, 0)
    assert.match(git('cat-file', 'commit', 'HEAD'), /gpgsig -----BEGIN SSH SIGNATURE-----/)
    const publicKey = await readFile(join(secrets, 'key.pub'), 'utf8')
    const allowed = join(secrets, 'allowed-signers')
    await writeFile(allowed, `sign@example.invalid ${publicKey}`)
    git('-c', `gpg.ssh.allowedSignersFile=${allowed}`, 'verify-commit', 'HEAD')
  })

  it('offers private-key consent with the default on when no agent or public file is available', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { secrets, git, commit } = setup
    delete process.env['SSH_AUTH_SOCK']
    await rm(join(secrets, 'key.pub'))
    let prompts = 0
    setApprovalHandler(async (request) => {
      prompts++
      assert.equal(request.title, 'Allow reading this Git signing key?')
      return { approved: true, remember: false }
    })
    await commit()
    assert.equal(prompts, 1)
    assert.match(git('cat-file', 'commit', 'HEAD'), /gpgsig -----BEGIN SSH SIGNATURE-----/)
  })

  it('does not replace the configured public identity with a different private key', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { secrets, git, commit } = setup
    git('config', 'user.signingKey', '../secrets/key.pub')
    execFileSync('/usr/bin/ssh-add', ['-D'], { stdio: 'ignore' })
    const other = join(secrets, 'other')
    execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', other])
    await writeFile(join(secrets, 'key.pub'), await readFile(`${other}.pub`))
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    await assert.rejects(commit, /does not match the configured SSH public key/)
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1')
  })

  it('preserves an agent refusal after the key passed preflight without retrying unsigned', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { secrets, git, commit } = setup
    const publicKey = await readFile(join(secrets, 'key.pub'), 'utf8')
    const blob = Buffer.from(publicKey.trim().split(' ')[1] ?? '', 'base64')
    const identities = Buffer.alloc(4 + 1 + 4 + 4 + blob.length + 4)
    identities.writeUInt32BE(identities.length - 4, 0)
    identities[4] = 12 // SSH_AGENT_IDENTITIES_ANSWER
    identities.writeUInt32BE(1, 5)
    identities.writeUInt32BE(blob.length, 9)
    blob.copy(identities, 13)
    const socket = join(secrets, 'refusing-agent.sock')
    const server = createServer((peer) => {
      let buffer = Buffer.alloc(0)
      peer.on('error', () => {})
      peer.on('data', (data: Buffer) => {
        buffer = Buffer.concat([buffer, data])
        while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
          const length = 4 + buffer.readUInt32BE(0)
          // List the expected identity, then refuse the actual signing request.
          peer.write(buffer[4] === 11 ? identities : Buffer.from([0, 0, 0, 1, 5]))
          buffer = buffer.subarray(length)
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve()
          })
        }),
    )
    process.env['SSH_AUTH_SOCK'] = socket
    let prompts = 0
    setApprovalHandler(async () => {
      prompts++
      return { approved: false, remember: false }
    })
    await assert.rejects(commit, /No unsigned retry was attempted\.[\s\S]*agent refused operation/)
    assert.equal(prompts, 0)
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1')
  })

  it('does not turn an agent communication error into private-key consent', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { secrets, git, commit } = setup
    const socket = join(secrets, 'broken-agent.sock')
    const server = createServer((peer) => {
      peer.on('error', () => {})
      peer.on('data', () => peer.end(Buffer.from([0, 0, 0, 1, 5])))
    })
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve()
          })
        }),
    )
    process.env['SSH_AUTH_SOCK'] = socket
    let prompts = 0
    setApprovalHandler(async () => {
      prompts++
      return { approved: false, remember: false }
    })
    await assert.rejects(commit, /Cannot inspect SSH signing identities/)
    assert.equal(prompts, 0)
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1')
  })

  it('declines before hooks or a signed/unsigned commit when Always ask is set, and does not remember rejection', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { repo, git, commit } = setup
    await setSetting('toolPermissionOverrides', { 'copse:git_commit': 'ask' })
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

  it('pins approved signing configuration against changes made during an Always ask prompt', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { repo, git, commit } = setup
    await setSetting('toolPermissionOverrides', { 'copse:git_commit': 'ask' })
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

  it('signs with a private key after one-commit consent with the setting off and no agent', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { repo, secrets, git, commit } = setup
    await setSetting('gitCommitSshAgentSocketAccess', false)
    delete process.env['SSH_AUTH_SOCK']
    git('config', 'user.signingKey', '../secrets/key')
    // No sibling public file is required: derive the identity only after consent.
    const publicKey = await readFile(join(secrets, 'key.pub'), 'utf8')
    await rm(join(secrets, 'key.pub'))
    const hooks = join(repo, 'hooks')
    await mkdir(hooks)
    await writeFile(
      join(hooks, 'pre-commit'),
      `#!/bin/sh\ncat '${join(secrets, 'key')}' > leaked-key 2>/dev/null\n/usr/bin/ssh-add -l > hook-output 2>&1\necho $? > hook-status\nexit 0\n`,
      { mode: 0o700 },
    )
    git('config', 'core.hooksPath', hooks)
    let prompts = 0
    setApprovalHandler(async (request) => {
      prompts++
      assert.equal(request.title, 'Allow reading this Git signing key?')
      assert.match(request.body, /Private key:/)
      assert.ok(request.body.includes(join(secrets, 'key')))
      assert.match(request.body, /Signed fixture/)
      assert.equal(request.allowRemember, false)
      assert.match(request.bodyAdvice ?? '', /never sent to the agent/)
      return { approved: true, remember: true }
    })
    const output = await commit()
    assert.equal(prompts, 1)
    assert.ok(!String(output).includes('PRIVATE KEY'))
    assert.equal((await readFile(join(repo, 'leaked-key'))).length, 0)
    assert.notEqual((await readFile(join(repo, 'hook-status'), 'utf8')).trim(), '0')
    const allowed = join(secrets, 'allowed-signers')
    await writeFile(allowed, `sign@example.invalid ${publicKey}`)
    git('-c', `gpg.ssh.allowedSignersFile=${allowed}`, 'verify-commit', 'HEAD')
    await writeFile(join(repo, 'change.txt'), 'second private-key commit\n')
    git('add', 'change.txt')
    await commit()
    assert.equal(prompts, 2, 'private key consent is never remembered')
  })

  it('rejects private-key consent before staging or hooks, even when remembering was requested', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { repo, git, commit } = setup
    await setSetting('gitCommitSshAgentSocketAccess', false)
    git('restore', '--staged', 'change.txt')
    const hooks = join(repo, 'hooks')
    await mkdir(hooks)
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\ntouch hook-ran\n', { mode: 0o700 })
    git('config', 'core.hooksPath', hooks)
    let prompts = 0
    setApprovalHandler(async () => {
      prompts++
      return { approved: false, remember: true }
    })
    await assert.rejects(() => commit(true), /User rejected reading the SSH signing key/)
    await assert.rejects(() => commit(true), /User rejected reading the SSH signing key/)
    assert.equal(prompts, 2)
    assert.equal(git('diff', '--cached'), '')
    assert.equal(existsSync(join(repo, 'hook-ran')), false)
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1')
  })

  it('denies Git access to the approved private key and preserves it when the lease ends', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { repo, secrets } = setup
    await setSetting('gitCommitSshAgentSocketAccess', false)
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    const lease = await leaseGitSigningBroker(repo)
    assert.ok(lease)
    const key = join(secrets, 'key')
    try {
      const probe = await runCommand('/bin/cat', [key], {
        cwd: repo,
        requireSandbox: true,
        sandboxConfig: lease.sandboxConfig,
      })
      assert.notEqual(probe.code, 0)
      assert.equal(probe.stdout, '')
    } finally {
      await lease.release()
    }
    assert.equal(existsSync(key), true)
  })

  it('refuses a private key replaced during approval and a permission revoked during approval', async (t) => {
    const setup = await fixture(t)
    if (!setup) return
    const { secrets, git, commit } = setup
    await setSetting('gitCommitSshAgentSocketAccess', false)
    setApprovalHandler(async () => {
      const key = join(secrets, 'key')
      const bytes = await readFile(key)
      await rm(key)
      await writeFile(key, bytes, { mode: 0o600 })
      return { approved: true, remember: false }
    })
    await assert.rejects(commit, /signing key changed during approval/)
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1')
    setApprovalHandler(async () => {
      await setSetting('toolPermissionOverrides', { 'copse:git_commit': 'block' })
      return { approved: true, remember: false }
    })
    await assert.rejects(commit, /signing authorization changed/)
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1')
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
