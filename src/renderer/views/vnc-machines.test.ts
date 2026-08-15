import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import type { VncNearbyServer } from '@shared/types/vnc.ts'
import { dedupeNearbyVncServers } from './vnc-machines.ts'

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
