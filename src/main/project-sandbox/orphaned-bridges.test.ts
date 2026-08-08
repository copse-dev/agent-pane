import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isOrphanedBridge } from './orphaned-bridges.ts'

const PREFIX = 'UNIX-LISTEN:/tmp/claude-'

/** The exact shape observed leaking on e2e shard 1 of run 31187232755. */
const BRIDGE_CMDLINE =
  'socat UNIX-LISTEN:/tmp/claude-http-9490f471c662679d.sock,fork,reuseaddr' +
  ' TCP:localhost:38689,keepalive,keepidle=10,keepintvl=5,keepcnt=3'

describe('isOrphanedBridge', () => {
  it('matches a reparented ASRT http bridge', () => {
    assert.equal(isOrphanedBridge(BRIDGE_CMDLINE, 1, PREFIX), true)
  })

  it('matches the socks bridge spawned when the proxy ports differ', () => {
    const socks =
      'socat UNIX-LISTEN:/tmp/claude-socks-9490f471c662679d.sock,fork,reuseaddr' +
      ' TCP:localhost:1080,keepalive'
    assert.equal(isOrphanedBridge(socks, 1, PREFIX), true)
  })

  it('leaves a bridge whose owner is still alive', () => {
    // The load-bearing case: a CI runner hosting a concurrent shard, or a second
    // app window. Killing this would break a working sandbox.
    assert.equal(isOrphanedBridge(BRIDGE_CMDLINE, 27949, PREFIX), false)
  })

  it('leaves unrelated orphans alone', () => {
    assert.equal(
      isOrphanedBridge('socat UNIX-LISTEN:/tmp/other.sock TCP:localhost:1', 1, PREFIX),
      false,
    )
    assert.equal(isOrphanedBridge('/usr/bin/Xvfb :99', 1, PREFIX), false)
    assert.equal(
      isOrphanedBridge('electron --app=/repo/tests/e2e/electron-shell', 1, PREFIX),
      false,
    )
  })

  it('is scoped to the running platform tmpdir', () => {
    // A macOS-style path must not be matched by a Linux prefix: the reaper only
    // ever signals bridges it could itself have spawned.
    const macBridge = 'socat UNIX-LISTEN:/var/folders/x/claude-http-abc.sock,fork TCP:localhost:1'
    assert.equal(isOrphanedBridge(macBridge, 1, PREFIX), false)
  })
})
