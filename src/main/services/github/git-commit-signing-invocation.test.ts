import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { spawnSync } from 'node:child_process'
import { resolveGitCommitSigningInvocation } from './git-service.ts'
import { setSetting } from '../storage/settings.ts'

describe('resolveGitCommitSigningInvocation', () => {
  let server: Server | undefined
  let directory: string | undefined
  const originalAuthSock = process.env['SSH_AUTH_SOCK']

  afterEach(async () => {
    await setSetting('gitCommitSshAgentSocketAccess', false)
    if (server) {
      const activeServer = server
      await new Promise<void>((resolve) => {
        activeServer.close(() => {
          resolve()
        })
      })
    }
    if (directory) await rm(directory, { recursive: true, force: true })
    server = undefined
    directory = undefined
    if (originalAuthSock === undefined) delete process.env['SSH_AUTH_SOCK']
    else process.env['SSH_AUTH_SOCK'] = originalAuthSock
  })

  it(
    'builds a commit-only socket overlay and replaces a private path with its public identity',
    { skip: process.platform !== 'darwin' },
    async () => {
      directory = await mkdtemp(join(tmpdir(), 'copse-git-signing-invocation-'))
      const socketPath = join(directory, 'agent.sock')
      server = createServer()
      const activeServer = server
      await new Promise<void>((resolve) => {
        activeServer.listen(socketPath, resolve)
      })

      const git = (...args: string[]): void => {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
      }
      git('init', '-q')
      git('config', 'commit.gpgSign', 'true')
      git('config', 'gpg.format', 'ssh')
      const privatePath = join(directory, 'id_ed25519')
      git('config', 'user.signingKey', privatePath)
      await writeFile(
        `${privatePath}.pub`,
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey test@example.test\n',
      )

      process.env['SSH_AUTH_SOCK'] = socketPath
      await setSetting('gitCommitSshAgentSocketAccess', true)

      const invocation = await resolveGitCommitSigningInvocation(directory)
      assert.ok(invocation)
      assert.deepEqual(invocation.gitConfigArgs, [
        '-c',
        'user.signingKey=key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey',
      ])
      assert.deepEqual(invocation.runOptions.sandboxConfig?.network, {
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: false,
        allowUnixSockets: [socketPath],
      })
    },
  )

  it('does nothing without explicit consent', async () => {
    directory = await mkdtemp(join(tmpdir(), 'copse-git-signing-disabled-'))
    assert.equal(await resolveGitCommitSigningInvocation(directory), null)
  })
})
