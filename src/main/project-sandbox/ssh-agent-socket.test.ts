import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sshAgentSocketAllowList } from './ssh-agent-socket.ts'

const LAUNCHD_SOCK = '/private/tmp/com.apple.launchd.AbCdEf1234/Listeners'

describe('sshAgentSocketAllowList', () => {
  it('admits exactly the socket SSH_AUTH_SOCK names on macOS', () => {
    assert.deepEqual(
      sshAgentSocketAllowList({ enabled: true, authSock: LAUNCHD_SOCK, platform: 'darwin' }),
      [LAUNCHD_SOCK],
    )
  })

  it('grants nothing while the user has not opted in', () => {
    assert.deepEqual(
      sshAgentSocketAllowList({ enabled: false, authSock: LAUNCHD_SOCK, platform: 'darwin' }),
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
      }),
      [],
    )
  })

  it('grants nothing on Windows, which has no seatbelt at all', () => {
    assert.deepEqual(
      sshAgentSocketAllowList({ enabled: true, authSock: LAUNCHD_SOCK, platform: 'win32' }),
      [],
    )
  })

  it('grants nothing when the environment names no socket', () => {
    for (const authSock of [undefined, '', '   ']) {
      assert.deepEqual(sshAgentSocketAllowList({ enabled: true, authSock, platform: 'darwin' }), [])
    }
  })

  // A relative path resolves against the agent's cwd, not the path pinned into
  // the profile, so the rule would not mean what it says. Refuse it instead.
  it('refuses a relative socket path rather than emitting a misleading rule', () => {
    assert.deepEqual(
      sshAgentSocketAllowList({ enabled: true, authSock: 'tmp/agent.sock', platform: 'darwin' }),
      [],
    )
  })

  it('trims incidental whitespace around an otherwise valid path', () => {
    assert.deepEqual(
      sshAgentSocketAllowList({
        enabled: true,
        authSock: `  ${LAUNCHD_SOCK}  `,
        platform: 'darwin',
      }),
      [LAUNCHD_SOCK],
    )
  })
})
