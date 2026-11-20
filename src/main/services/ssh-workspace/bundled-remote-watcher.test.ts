import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getBundledRemoteWatcherPath, remoteWatcherTargetFor } from './bundled-remote-watcher.ts'

describe('remoteWatcherTargetFor', () => {
  it('maps uname output to the CI target triples', () => {
    assert.equal(remoteWatcherTargetFor('Linux', 'x86_64'), 'x86_64-unknown-linux-musl')
    assert.equal(remoteWatcherTargetFor('Linux', 'amd64'), 'x86_64-unknown-linux-musl')
    assert.equal(remoteWatcherTargetFor('Linux', 'aarch64'), 'aarch64-unknown-linux-musl')
    assert.equal(remoteWatcherTargetFor('Linux', 'arm64'), 'aarch64-unknown-linux-musl')
    assert.equal(remoteWatcherTargetFor('Darwin', 'arm64'), 'aarch64-apple-darwin')
    assert.equal(remoteWatcherTargetFor('Darwin', 'x86_64'), 'x86_64-apple-darwin')
  })

  it('declines platforms the CI lane does not build', () => {
    // FreeBSD/unknown remotes stay on the polling floor rather than getting a
    // binary that cannot run.
    assert.equal(remoteWatcherTargetFor('FreeBSD', 'x86_64'), null)
    assert.equal(remoteWatcherTargetFor('Linux', 'riscv64'), null)
    assert.equal(remoteWatcherTargetFor('unknown', 'unknown'), null)
  })
})

describe('getBundledRemoteWatcherPath', () => {
  it('is null for unmapped platforms without touching the filesystem', () => {
    assert.equal(getBundledRemoteWatcherPath('SunOS', 'sparc'), null)
  })
})
