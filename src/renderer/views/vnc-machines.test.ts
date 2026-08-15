import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import type { VncNearbyServer } from '@shared/types/vnc.ts'
import { dedupeNearbyVncServers, parseVncEndpoint, preferredVncUsername } from './vnc-machines.ts'

const studio: VncNearbyServer = {
  name: 'Jonathan’s Mac mini',
  host: 'jonathans-mac-mini.local.',
  port: 5900,
  addresses: ['192.168.0.21'],
}

describe('dedupeNearbyVncServers', () => {
  it('prefers a saved SSH machine with the same hostname or address', () => {
    const hosts: SshWorkspaceHost[] = [
      { id: 'studio', label: 'Studio', host: 'jonathans-mac-mini.local' },
    ]

    assert.deepEqual(dedupeNearbyVncServers([studio], hosts), [])
    assert.deepEqual(
      dedupeNearbyVncServers([studio], [{ id: 'studio', label: 'Studio', host: '192.168.0.21' }]),
      [],
    )
  })

  it('matches a saved label to the Bonjour device name despite punctuation', () => {
    const hosts: SshWorkspaceHost[] = [
      { id: 'studio', label: "Jonathan's Mac mini", host: 'studio-alias' },
    ]

    assert.deepEqual(dedupeNearbyVncServers([studio], hosts), [])
  })

  it('collapses duplicate Bonjour advertisements that share an endpoint and port', () => {
    const duplicate = {
      ...studio,
      name: 'Jonathan Mac mini',
      host: 'alternate.local',
    }

    assert.deepEqual(dedupeNearbyVncServers([studio, duplicate], []), [studio])
  })

  it('preserves different machines and different VNC ports', () => {
    const secondPort = { ...studio, port: 5901 }
    const laptop = {
      name: 'Laptop',
      host: 'laptop.local',
      port: 5900,
      addresses: ['192.168.0.22'],
    }

    assert.deepEqual(dedupeNearbyVncServers([studio, secondPort, laptop], []), [
      studio,
      secondPort,
      laptop,
    ])
  })
})

describe('parseVncEndpoint', () => {
  it('uses the default port for a hostname or bare IP address', () => {
    assert.deepEqual(parseVncEndpoint('studio.local', 5900), {
      host: 'studio.local',
      port: 5900,
    })
    assert.deepEqual(parseVncEndpoint('192.168.0.21', 5900), {
      host: '192.168.0.21',
      port: 5900,
    })
  })

  it('accepts a custom port in a hostname or bracketed IPv6 address', () => {
    assert.deepEqual(parseVncEndpoint('studio.local:5901', 5900), {
      host: 'studio.local',
      port: 5901,
    })
    assert.deepEqual(parseVncEndpoint('[fd00::21]:5902', 5900), {
      host: 'fd00::21',
      port: 5902,
    })
  })

  it('leaves a bare IPv6 address on the default port', () => {
    assert.deepEqual(parseVncEndpoint('fd00::21', 5900), {
      host: 'fd00::21',
      port: 5900,
    })
  })

  it('rejects malformed or out-of-range port overrides', () => {
    assert.equal(parseVncEndpoint('studio.local:vnc', 5900), null)
    assert.equal(parseVncEndpoint('studio.local:70000', 5900), null)
    assert.equal(parseVncEndpoint('[fd00::21]:', 5900), null)
  })
})

describe('preferredVncUsername', () => {
  const hosts: SshWorkspaceHost[] = [
    { id: 'studio', label: 'Studio', host: 'studio.local', user: 'ssh-user' },
  ]

  it('prefills a saved SSH target from its SSH account', () => {
    assert.equal(
      preferredVncUsername({ kind: 'ssh', hostId: 'studio', remotePort: 5900 }, hosts, null),
      'ssh-user',
    )
  })

  it('prefers a previously successful screen-sharing username', () => {
    assert.equal(
      preferredVncUsername(
        { kind: 'ssh', hostId: 'studio', remotePort: 5900 },
        hosts,
        'screen-user',
      ),
      'screen-user',
    )
  })

  it('does not borrow an SSH username for another kind of target', () => {
    assert.equal(preferredVncUsername({ kind: 'loopback', port: 5900 }, hosts, null), '')
  })
})
