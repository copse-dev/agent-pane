import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  importSshConfigHosts,
  saveSshConfigHost,
  unsavedSshConfigHosts,
} from './ssh-host-helpers.ts'

describe('importSshConfigHosts', () => {
  it('keeps every alias when generated ids collide', () => {
    const result = importSshConfigHosts(
      [],
      [
        { id: 'build-prod', label: 'build.prod', host: 'build.prod' },
        { id: 'build-prod', label: 'build-prod', host: 'build-prod' },
      ],
    )

    assert.deepEqual(
      result.hosts.map((host) => ({ id: host.id, host: host.host })),
      [
        { id: 'build-prod', host: 'build.prod' },
        { id: 'build-prod-2', host: 'build-prod' },
      ],
    )
    assert.deepEqual(result.importedHostIds, ['build-prod', 'build-prod-2'])
    assert.equal(result.firstAliasHostId, 'build-prod')
  })

  it('recognizes a legacy import by its SSH target and preserves its id', () => {
    const existing = [{ id: 'build-prod', label: 'build.prod', host: 'build.prod' }]
    const result = importSshConfigHosts(existing, [
      { id: 'build-prod-a1b2c3d4', label: 'build.prod', host: 'BUILD.PROD' },
      { id: 'build-prod', label: 'build-prod', host: 'build-prod' },
    ])

    assert.deepEqual(
      result.hosts.map((host) => ({ id: host.id, host: host.host })),
      [
        { id: 'build-prod', host: 'build.prod' },
        { id: 'build-prod-2', host: 'build-prod' },
      ],
    )
    assert.deepEqual(result.importedHostIds, ['build-prod-2'])
    assert.equal(result.firstAliasHostId, 'build-prod')
  })
})

describe('unsavedSshConfigHosts', () => {
  it('drops config hosts a saved host already targets, ignoring case', () => {
    const saved = [{ id: 'studio', label: 'Studio', host: 'Studio' }]
    const aliases = [
      { id: 'studio', label: 'studio', host: 'studio' },
      { id: 'build', label: 'build', host: 'build' },
    ]
    assert.deepEqual(unsavedSshConfigHosts(saved, aliases), [aliases[1]])
  })
})

describe('saveSshConfigHost', () => {
  it('saves only the chosen alias and returns its id, made unique when needed', () => {
    const saved = [{ id: 'build', label: 'Build server', host: 'build.example' }]
    const result = saveSshConfigHost(saved, { id: 'build', label: 'build', host: 'build' })
    assert.equal(result.hostId, 'build-2')
    assert.deepEqual(result.hosts, [...saved, { id: 'build-2', label: 'build', host: 'build' }])
  })
})
