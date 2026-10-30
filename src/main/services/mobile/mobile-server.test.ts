import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'
import { MOBILE_READ_DISPATCH, mobileLanAddresses, mobileRequestAllowed } from './mobile-server.ts'

function request(
  peer: string,
  host = '192.168.1.41:4000',
  origin?: string,
  method = 'GET',
): IncomingMessage {
  const socket = new Socket()
  Object.defineProperty(socket, 'remoteAddress', { value: peer })
  const req = new IncomingMessage(socket)
  req.method = method
  req.headers.host = host
  if (origin !== undefined) req.headers.origin = origin
  return req
}

function networkAddress(address: string, family: 'IPv4' | 'IPv6' = 'IPv4'): NetworkInterfaceInfo {
  return {
    address,
    netmask: family === 'IPv4' ? '255.255.255.0' : 'ffff:ffff:ffff:ffff::',
    family,
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: family === 'IPv4' ? `${address}/24` : `${address}/64`,
    scopeid: 0,
  }
}

describe('mobile LAN interfaces', () => {
  it('keeps interface names so the UI can distinguish Wi-Fi from virtual networks', () => {
    assert.deepEqual(
      mobileLanAddresses({
        en0: [networkAddress('192.168.1.41')],
        utun4: [networkAddress('10.20.0.2')],
        lo0: [{ ...networkAddress('127.0.0.1'), internal: true }],
        en6: [networkAddress('2001:db8::1', 'IPv6')],
      }),
      [
        { address: '192.168.1.41', interfaceName: 'en0', virtual: false },
        { address: '10.20.0.2', interfaceName: 'utun4', virtual: true },
      ],
    )
  })
  it('puts the default-route interface first and virtual networks last', () => {
    const interfaces = {
      bridge100: [networkAddress('192.168.64.1')],
      utun4: [networkAddress('10.20.0.2')],
      en7: [networkAddress('10.0.0.5')],
      en0: [networkAddress('192.168.0.191')],
    }
    assert.deepEqual(
      mobileLanAddresses(interfaces, 'en0').map((candidate) => candidate.interfaceName),
      ['en0', 'en7', 'bridge100', 'utun4'],
    )
    // Without a known default route, physical interfaces still lead.
    assert.deepEqual(
      mobileLanAddresses(interfaces).map((candidate) => candidate.interfaceName),
      ['en7', 'en0', 'bridge100', 'utun4'],
    )
  })
})

describe('mobile request boundary', () => {
  const authority = '192.168.1.41:4000'
  const origin = `https://${authority}`
  it('limits paired phones to activity, thread, and thread-image reads', () => {
    assert.deepEqual(Object.keys(MOBILE_READ_DISPATCH).sort(), [
      'activity',
      'thread',
      'threadImage',
    ])
  })
  it('allows only the literal bound host and a private peer', () => {
    assert.equal(mobileRequestAllowed(request('192.168.1.55'), [authority]), true)
    assert.equal(mobileRequestAllowed(request('8.8.8.8'), [authority]), false)
    assert.equal(
      mobileRequestAllowed(request('192.168.1.55', 'copse.local:4000'), [authority]),
      false,
    )
    assert.equal(
      mobileRequestAllowed(request('192.168.1.55', '192.168.1.41:4001'), [authority]),
      false,
    )
  })
  it('rejects a foreign origin and a missing origin on writes', () => {
    assert.equal(
      mobileRequestAllowed(request('192.168.1.55', authority, 'https://evil.test'), [authority]),
      false,
    )
    assert.equal(
      mobileRequestAllowed(request('192.168.1.55', authority, undefined, 'POST'), [authority]),
      false,
    )
    assert.equal(
      mobileRequestAllowed(request('192.168.1.55', authority, origin, 'POST'), [authority]),
      true,
    )
  })
  it('accepts the trusted name only when it is one of the served authorities', () => {
    const name = 'lan.abcdefgh2345.u.copse.me:4000'
    const served = [authority, name]
    assert.equal(mobileRequestAllowed(request('192.168.1.55', name), [authority]), false)
    assert.equal(mobileRequestAllowed(request('192.168.1.55', name), served), true)
    assert.equal(mobileRequestAllowed(request('8.8.8.8', name), served), false)
    // Another label, or the name without the port, is not this Mac.
    assert.equal(
      mobileRequestAllowed(request('192.168.1.55', 'lan.zzzzzzzzzzzz.u.copse.me:4000'), served),
      false,
    )
    assert.equal(
      mobileRequestAllowed(request('192.168.1.55', 'lan.abcdefgh2345.u.copse.me'), served),
      false,
    )
  })
  it('binds Origin to the authority the request named', () => {
    const name = 'lan.abcdefgh2345.u.copse.me:4000'
    const served = [authority, name]
    assert.equal(
      mobileRequestAllowed(request('192.168.1.55', name, `https://${name}`, 'POST'), served),
      true,
    )
    // A page on the IP origin cannot post to the name, or the other way round.
    assert.equal(mobileRequestAllowed(request('192.168.1.55', name, origin, 'POST'), served), false)
    assert.equal(
      mobileRequestAllowed(request('192.168.1.55', authority, `https://${name}`, 'POST'), served),
      false,
    )
  })
})
