import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseTrustedSshHosts, sanitizeTrustedSshHosts } from './trusted-ssh-hosts.ts'

describe('trusted SSH hosts', () => {
  it('parses one host per line, lower-cased, without comments, blanks, or duplicates', () => {
    assert.deepEqual(
      parseTrustedSshHosts('Mini\n\n# comment\nbuild.example.com.\nmini\n  10.0.0.5  \nfe80::1'),
      ['mini', 'build.example.com', '10.0.0.5', 'fe80::1'],
    )
  })

  it('drops entries that are not a bare host', () => {
    assert.deepEqual(
      parseTrustedSshHosts('dev@mini\nmini:/tmp\nmini box\nhost;rm\n*.example.com'),
      [],
    )
  })

  it('sanitizes a stored value', () => {
    assert.deepEqual(sanitizeTrustedSshHosts(['Mini', 7, 'mini', 'bad host']), ['mini'])
    assert.deepEqual(sanitizeTrustedSshHosts('mini'), [])
  })
})
