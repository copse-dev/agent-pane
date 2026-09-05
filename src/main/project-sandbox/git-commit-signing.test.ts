import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import {
  gitCommitSigningSandboxOverlay,
  parseSshPublicKey,
  resolveInlineSshPublicSigningKey,
  resolveSshAgentSocketAllowList,
  sshAgentSocketAllowList,
} from './git-commit-signing.ts'

const LAUNCHD_SOCKET = '/private/tmp/com.apple.launchd.example/Listeners'
const require = createRequire(import.meta.url)

describe('sandbox-runtime unix-socket patch', () => {
  it('honours the per-spawn socket list instead of the process-global list', async () => {
    const entry = require.resolve('@anthropic-ai/sandbox-runtime')
    const manager = join(dirname(entry), 'sandbox', 'sandbox-manager.js')
    const source = await readFile(manager, 'utf8')
    assert.match(
      source,
      /allowUnixSockets: customConfig\?\.network\?\.allowUnixSockets \?\? getAllowUnixSockets\(\)/,
    )
  })

  it(
    'emits the per-spawn socket in the generated macOS seatbelt profile',
    { skip: process.platform !== 'darwin' },
    async () => {
      await SandboxManager.initialize(
        {
          network: { allowedDomains: [], deniedDomains: [] },
          filesystem: { denyRead: [], allowWrite: [], denyWrite: [], allowGitConfig: true },
        },
        () => Promise.resolve(false),
        false,
      )
      try {
        const wrapped = await SandboxManager.wrapWithSandboxArgv('true', '/bin/zsh', {
          network: {
            allowedDomains: [],
            deniedDomains: [],
            allowUnixSockets: [LAUNCHD_SOCKET],
          },
        })
        assert.ok(
          wrapped.argv.some((arg) =>
            arg.includes(`network-outbound (remote unix-socket (subpath "${LAUNCHD_SOCKET}"))`),
          ),
        )
      } finally {
        await SandboxManager.reset()
      }
    },
  )
})

describe('sshAgentSocketAllowList', () => {
  it('admits exactly the named socket on macOS after opt-in', () => {
    assert.deepEqual(
      sshAgentSocketAllowList({
        enabled: true,
        authSock: LAUNCHD_SOCKET,
        platform: 'darwin',
        isSocket: true,
      }),
      [LAUNCHD_SOCKET],
    )
  })

  it('fails closed for opt-out, unsupported platforms, and unsafe paths', () => {
    const base = { enabled: true, platform: 'darwin' as const, isSocket: true }
    assert.deepEqual(
      sshAgentSocketAllowList({ ...base, enabled: false, authSock: LAUNCHD_SOCKET }),
      [],
    )
    assert.deepEqual(
      sshAgentSocketAllowList({ ...base, platform: 'linux', authSock: LAUNCHD_SOCKET }),
      [],
    )
    assert.deepEqual(sshAgentSocketAllowList({ ...base, authSock: 'relative.sock' }), [])
    assert.deepEqual(
      sshAgentSocketAllowList({ ...base, authSock: '/private/tmp/../tmp/agent.sock' }),
      [],
    )
    assert.deepEqual(sshAgentSocketAllowList({ ...base, authSock: '/', isSocket: false }), [])
  })

  it('checks the path is a real unix socket', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copse-signing-socket-'))
    const socketPath = join(dir, 'agent.sock')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      assert.deepEqual(
        await resolveSshAgentSocketAllowList({
          enabled: true,
          authSock: socketPath,
          platform: 'darwin',
        }),
        [socketPath],
      )
      assert.deepEqual(
        await resolveSshAgentSocketAllowList({
          enabled: true,
          authSock: dir,
          platform: 'darwin',
        }),
        [],
      )
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('adds only the socket capability to the normal commit sandbox', () => {
    const overlay = gitCommitSigningSandboxOverlay('/tmp/project', [LAUNCHD_SOCKET])
    assert.deepEqual(overlay.network, {
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: false,
      allowUnixSockets: [LAUNCHD_SOCKET],
    })
    assert.ok(overlay.filesystem)
  })
})

describe('SSH public signing identity', () => {
  const publicLine = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey comment@example.test'

  it('normalizes one public key and drops its comment', () => {
    assert.equal(
      parseSshPublicKey(`${publicLine}\n`),
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey',
    )
    assert.equal(parseSshPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----'), null)
    assert.equal(parseSshPublicKey(`${publicLine}\n${publicLine}`), null)
  })

  it('uses a public sibling instead of exposing the configured private-key path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copse-signing-key-'))
    const privatePath = join(dir, 'id_ed25519')
    await writeFile(`${privatePath}.pub`, `${publicLine}\n`)
    try {
      assert.equal(
        await resolveInlineSshPublicSigningKey(privatePath),
        'key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('accepts an explicitly configured public-key path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copse-signing-public-key-'))
    const publicPath = join(dir, 'signing.pub')
    await writeFile(publicPath, publicLine)
    try {
      assert.equal(
        await resolveInlineSshPublicSigningKey(publicPath),
        'key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses symlinks and files that are not public keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copse-signing-refusal-'))
    const target = join(dir, 'target.pub')
    const link = join(dir, 'link.pub')
    const invalid = join(dir, 'invalid.pub')
    await writeFile(target, publicLine)
    await symlink(target, link)
    await writeFile(invalid, '-----BEGIN OPENSSH PRIVATE KEY-----')
    try {
      assert.equal(await resolveInlineSshPublicSigningKey(link), null)
      assert.equal(await resolveInlineSshPublicSigningKey(invalid), null)
      assert.equal(await resolveInlineSshPublicSigningKey(join(dir, 'missing')), null)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
