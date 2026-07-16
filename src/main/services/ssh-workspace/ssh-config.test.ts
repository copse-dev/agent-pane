import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseSshConfig } from './ssh-config.ts'

describe('parseSshConfig', () => {
  it('extracts host aliases and options', () => {
    const aliases = parseSshConfig(`
Host dev github.com
  HostName example.com
  User alice
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
`)
    assert.equal(aliases.length, 2)
    const dev = aliases.find((entry) => entry.alias === 'dev')
    assert.ok(dev)
    assert.equal(dev.hostname, 'example.com')
    assert.equal(dev.user, 'alice')
    assert.equal(dev.port, 2222)
    assert.match(String(dev.identityFile), /id_ed25519$/)
  })

  it('skips wildcard host patterns', () => {
    const aliases = parseSshConfig('Host *\n  ForwardAgent yes\nHost lab\n  HostName lab.local\n')
    assert.equal(aliases.length, 1)
    assert.equal(aliases[0]?.alias, 'lab')
  })

  it('strips quotes from identity file paths', () => {
    const aliases = parseSshConfig(`
Host dev
  IdentityFile "/home/alice/.ssh/my key"
`)
    assert.equal(aliases.length, 1)
    assert.equal(aliases[0]?.identityFile, '/home/alice/.ssh/my key')
  })
})
