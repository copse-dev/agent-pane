import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { MOBILE_READ_DISPATCH, mobileRequestAllowed } from './mobile-server.ts'

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

describe('mobile request boundary', () => {
  const authority = '192.168.1.41:4000'
  const origin = `https://${authority}`
  it('has exactly two read-only data operations', () => {
    assert.deepEqual(Object.keys(MOBILE_READ_DISPATCH).sort(), ['activity', 'thread'])
  })
  it('allows only the literal bound host and a private peer', () => {
    assert.equal(mobileRequestAllowed(request('192.168.1.55'), authority, origin), true)
    assert.equal(mobileRequestAllowed(request('8.8.8.8'), authority, origin), false)
    assert.equal(
      mobileRequestAllowed(request('192.168.1.55', 'copse.local:4000'), authority, origin),
      false,
    )
    assert.equal(
      mobileRequestAllowed(request('192.168.1.55', '192.168.1.41:4001'), authority, origin),
      false,
    )
  })
  it('rejects a foreign origin and a missing origin on writes', () => {
    assert.equal(
      mobileRequestAllowed(
        request('192.168.1.55', authority, 'https://evil.test'),
        authority,
        origin,
      ),
      false,
    )
    assert.equal(
      mobileRequestAllowed(
        request('192.168.1.55', authority, undefined, 'POST'),
        authority,
        origin,
      ),
      false,
    )
    assert.equal(
      mobileRequestAllowed(request('192.168.1.55', authority, origin, 'POST'), authority, origin),
      true,
    )
  })
})
