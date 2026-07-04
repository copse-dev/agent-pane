import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sfwInstallArgs } from './socket-firewall.ts'

describe('sfwInstallArgs', () => {
  it('installs sfw globally', () => {
    const args = sfwInstallArgs()
    assert.equal(args[0], 'install')
    assert.ok(args.includes('-g'))
  })

  it('pins sfw to an exact version (no range)', () => {
    const spec = sfwInstallArgs().find((a) => a.startsWith('sfw@'))
    assert.ok(spec, 'expected an sfw@<version> spec')
    const version = spec.slice('sfw@'.length)
    // Exact x.y.z — no caret/tilde/tag/range that could resolve to another version.
    assert.match(version, /^\d+\.\d+\.\d+$/, `version not pinned exactly: ${version}`)
  })

  it('disables npm lifecycle scripts for the bootstrap install', () => {
    assert.ok(sfwInstallArgs().includes('--ignore-scripts'))
  })
})
