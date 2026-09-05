import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { resolveSshAgentSocketAllowList, sshAgentSocketAllowList } from './ssh-agent-socket.ts'

const LAUNCHD_SOCK = '/private/tmp/com.apple.launchd.AbCdEf1234/Listeners'

describe('sshAgentSocketAllowList', () => {
  it('admits exactly the socket SSH_AUTH_SOCK names on macOS', () => {
    assert.deepEqual(
      sshAgentSocketAllowList({
        enabled: true,
        authSock: LAUNCHD_SOCK,
        platform: 'darwin',
        isSocket: true,
      }),
      [LAUNCHD_SOCK],
    )
  })

  it('grants nothing while the user has not opted in', () => {
    assert.deepEqual(
      sshAgentSocketAllowList({
        enabled: false,
        authSock: LAUNCHD_SOCK,
        platform: 'darwin',
        isSocket: true,
      }),
      [],
    )
  })

  // Linux enforces the same boundary with a seccomp filter on socket(AF_UNIX),
  // which cannot read a path — so the only knob there opens *every* unix socket.
  // Buying one socket at that price is not a trade to make silently.
  it('grants nothing on Linux, where the equivalent rule is all-or-nothing', () => {
    assert.deepEqual(
      sshAgentSocketAllowList({
        enabled: true,
        authSock: '/run/user/1000/keyring/ssh',
        platform: 'linux',
        isSocket: true,
      }),
      [],
    )
  })

  it('grants nothing on Windows, which has no seatbelt at all', () => {
    assert.deepEqual(
      sshAgentSocketAllowList({
        enabled: true,
        authSock: LAUNCHD_SOCK,
        platform: 'win32',
        isSocket: true,
      }),
      [],
    )
  })

  it('grants nothing when the environment names no socket', () => {
    for (const authSock of [undefined, '', '   ']) {
      assert.deepEqual(
        sshAgentSocketAllowList({ enabled: true, authSock, platform: 'darwin', isSocket: true }),
        [],
      )
    }
  })

  // A relative path resolves against the agent's cwd, not the path pinned into
  // the profile, so the rule would not mean what it says. Refuse it instead.
  it('refuses a relative socket path rather than emitting a misleading rule', () => {
    assert.deepEqual(
      sshAgentSocketAllowList({
        enabled: true,
        authSock: 'tmp/agent.sock',
        platform: 'darwin',
        isSocket: true,
      }),
      [],
    )
  })

  it('trims incidental whitespace around an otherwise valid path', () => {
    assert.deepEqual(
      sshAgentSocketAllowList({
        enabled: true,
        authSock: `  ${LAUNCHD_SOCK}  `,
        platform: 'darwin',
        isSocket: true,
      }),
      [LAUNCHD_SOCK],
    )
  })
})

// Review on #2344: ASRT emits `(subpath "<path>")` per entry, so a path that is
// not a socket node is not a narrower grant — it is a wider one. A directory
// admits every socket beneath it; `/` admits all of them.
describe('sshAgentSocketAllowList refuses anything but a socket node', () => {
  it('grants nothing when the path is not a socket', () => {
    assert.deepEqual(
      sshAgentSocketAllowList({
        enabled: true,
        authSock: '/private/tmp/com.apple.launchd.AbCdEf1234',
        platform: 'darwin',
        isSocket: false,
      }),
      [],
    )
  })

  it('grants nothing for the root directory even when told it is a socket', () => {
    // Belt and braces: `/` is normalised and absolute, so only the socket check
    // stands between a misread env var and a grant over every unix socket.
    assert.deepEqual(
      sshAgentSocketAllowList({
        enabled: true,
        authSock: '/',
        platform: 'darwin',
        isSocket: false,
      }),
      [],
    )
  })

  it('refuses a path that is not already normalised', () => {
    // `/a/../b` pins one string in the profile while the kernel resolves another.
    assert.deepEqual(
      sshAgentSocketAllowList({
        enabled: true,
        authSock: '/private/tmp/../tmp/agent.sock',
        platform: 'darwin',
        isSocket: true,
      }),
      [],
    )
  })
})

describe('resolveSshAgentSocketAllowList against a real filesystem', () => {
  it('admits a real unix socket and refuses the directory holding it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-agent-allowlist-'))
    const sock = join(dir, 'agent.sock')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(sock, resolve))
    try {
      // Platform is forced to darwin: the check under test is the socket one,
      // and the macOS gate would otherwise mask it on this Linux host.
      const opts = { enabled: true, platform: 'darwin' as const }
      assert.deepEqual(resolveSshAgentSocketAllowList({ ...opts, authSock: sock }), [sock])
      assert.deepEqual(resolveSshAgentSocketAllowList({ ...opts, authSock: dir }), [])
      assert.deepEqual(
        resolveSshAgentSocketAllowList({ ...opts, authSock: join(dir, 'missing.sock') }),
        [],
      )
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
