import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { importSshConfigHosts } from './ssh-host-helpers.ts'

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
