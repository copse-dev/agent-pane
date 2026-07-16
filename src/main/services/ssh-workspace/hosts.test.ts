import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hostFromSshConfigAlias } from './hosts.ts'

describe('hostFromSshConfigAlias', () => {
  it('uses the config alias as the SSH target and omits CLI overrides', () => {
    const host = hostFromSshConfigAlias({
      alias: 'dev',
      hostname: '10.0.0.5',
      user: 'alice',
      port: 2222,
      identityFile: '/home/alice/.ssh/id_ed25519',
    })
    assert.equal(host.host, 'dev')
    assert.equal(host.label, 'dev')
    // Leave User/Port/IdentityFile to ~/.ssh/config so ProxyCommand %p/%r work.
    assert.equal(host.user, undefined)
    assert.equal(host.port, undefined)
    assert.equal(host.identityFile, undefined)
  })
})
