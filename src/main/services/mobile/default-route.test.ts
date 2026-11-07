import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isVirtualInterface, parseDefaultRouteInterface } from './default-route.ts'

describe('parseDefaultRouteInterface', () => {
  it('reads the interface from macOS route output', () => {
    const output = [
      '   route to: default',
      'destination: default',
      '       mask: default',
      '    gateway: 192.168.0.1',
      '  interface: en0',
      '      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>',
    ].join('\n')
    assert.equal(parseDefaultRouteInterface('darwin', output), 'en0')
  })

  it('reads the device from Linux ip route output', () => {
    assert.equal(
      parseDefaultRouteInterface(
        'linux',
        'default via 192.168.1.1 dev wlp2s0 proto dhcp src 192.168.1.20 metric 600\n',
      ),
      'wlp2s0',
    )
  })

  it('returns null without a default route', () => {
    assert.equal(
      parseDefaultRouteInterface('darwin', 'route: writing to routing socket: not in table'),
      null,
    )
    assert.equal(parseDefaultRouteInterface('linux', ''), null)
  })
})

describe('isVirtualInterface', () => {
  it('flags VM bridges, VPN tunnels and peer-to-peer links', () => {
    for (const name of [
      'bridge100',
      'vmnet8',
      'vboxnet0',
      'docker0',
      'br-1a2b',
      'virbr0',
      'utun4',
      'tun0',
      'wg0',
      'awdl0',
      'llw0',
    ])
      assert.equal(isVirtualInterface(name), true, name)
  })

  it('keeps Wi-Fi and Ethernet', () => {
    for (const name of ['en0', 'en7', 'eth0', 'wlan0', 'wlp2s0', 'enp3s0'])
      assert.equal(isVirtualInterface(name), false, name)
  })
})
