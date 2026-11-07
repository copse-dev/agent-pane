import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  packageRegistryOrigin,
  parseTrustedPackageRegistries,
  sanitizeTrustedPackageRegistries,
} from './trusted-package-registries.ts'

describe('trusted package registries', () => {
  it('reduces a registry URL or bare host to its origin', () => {
    assert.equal(
      packageRegistryOrigin('https://NPM.corp.example/api/npm/'),
      'https://npm.corp.example',
    )
    assert.equal(packageRegistryOrigin('pypi.corp.example/simple'), 'https://pypi.corp.example')
    assert.equal(packageRegistryOrigin('http://localhost:4873'), 'http://localhost:4873')
  })

  it('refuses what cannot be compared safely', () => {
    for (const value of [
      'http://npm.corp.example',
      'https://user:secret@npm.corp.example',
      'ftp://npm.corp.example',
      'direct',
      'off',
      'two words.example',
      '',
    ]) {
      assert.equal(packageRegistryOrigin(value), null, value)
    }
  })

  it('parses the textarea and sanitizes stored values', () => {
    assert.deepEqual(
      parseTrustedPackageRegistries(
        'https://npm.corp.example\n# comment\n\nnpm.corp.example/other\nhttp://bad.example',
      ),
      ['https://npm.corp.example'],
    )
    assert.deepEqual(sanitizeTrustedPackageRegistries(['https://a.example', 7, 'direct']), [
      'https://a.example',
    ])
    assert.deepEqual(sanitizeTrustedPackageRegistries('https://a.example'), [])
  })
})
