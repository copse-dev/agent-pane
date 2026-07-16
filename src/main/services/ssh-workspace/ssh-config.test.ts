import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSshConfig, readSshConfigAliases, resolveSshIncludePath } from './ssh-config.ts'

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

  it('accepts Key=value forms used by some generated configs', () => {
    const aliases = parseSshConfig(`
Host tunnel
  HostName 127.0.0.1
  Port=25196
  StrictHostKeyChecking=no
`)
    const tunnel = aliases[0]
    assert.ok(tunnel)
    assert.equal(tunnel.alias, 'tunnel')
    assert.equal(tunnel.port, 25196)
  })
})

describe('resolveSshIncludePath', () => {
  it('resolves relative includes against the including file directory', () => {
    assert.equal(
      resolveSshIncludePath('ddg/*', '/home/alice/.ssh/config'),
      '/home/alice/.ssh/ddg/*',
    )
  })
})

describe('readSshConfigAliases', () => {
  it('follows Include globs so hosts in nested files are imported', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-ssh-config-'))
    try {
      const sshDir = join(root, '.ssh')
      const ddgDir = join(sshDir, 'ddg')
      mkdirSync(ddgDir, { recursive: true })
      writeFileSync(join(sshDir, 'config'), 'Include ddg/*\nHost top\n  HostName top.example\n')
      writeFileSync(
        join(ddgDir, 'euw-serp-dev-testing16'),
        `Host euw-serp-dev-testing16
  HostName 127.0.0.1
  Port 25196
  User jkingston
  IdentityFile ~/.ssh/ddg-dev
`,
      )
      const aliases = readSshConfigAliases(join(sshDir, 'config'))
      const names = aliases.map((a) => a.alias).sort()
      assert.deepEqual(names, ['euw-serp-dev-testing16', 'top'])
      const nested = aliases.find((a) => a.alias === 'euw-serp-dev-testing16')
      assert.ok(nested)
      assert.equal(nested.port, 25196)
      assert.equal(nested.user, 'jkingston')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
