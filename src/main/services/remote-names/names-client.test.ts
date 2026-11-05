import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { utf8 } from '@copse/remote-protocol/encoding.ts'
import {
  exportDevicePublicKey,
  generateDeviceKeyPair,
  keyThumbprint,
  verifyText,
} from '@copse/remote-protocol/keys.ts'
import { canonicalRequest } from '@copse/remote-protocol/signing.ts'
import { NamesApiError, NamesClient, type NamesDeviceKey } from './names-client.ts'

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body: Uint8Array
}

async function deviceKey(): Promise<{ key: NamesDeviceKey; publicCryptoKey: CryptoKey }> {
  const pair = await generateDeviceKeyPair()
  const publicKey = await exportDevicePublicKey(pair.publicKey)
  return {
    key: { privateKey: pair.privateKey, publicKey, thumbprint: await keyThumbprint(publicKey) },
    publicCryptoKey: pair.publicKey,
  }
}

function recorder(reply: (sent: Sent) => Response): {
  sent: Sent[]
  fetch: (url: string, init: RequestInit) => Promise<Response>
} {
  const sent: Sent[] = []
  return {
    sent,
    fetch: (url, init): Promise<Response> => {
      const headers = new Headers(init.headers)
      const body = init.body instanceof Uint8Array ? init.body : new Uint8Array()
      const entry = {
        url,
        method: init.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()),
        body,
      }
      sent.push(entry)
      assert.equal(init.redirect, 'error')
      return Promise.resolve(reply(entry))
    },
  }
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const label = 'abcdefgh2345'

describe('NamesClient', () => {
  it('signs each request over the exact method, path, time, nonce and body', async () => {
    const { key, publicCryptoKey } = await deviceKey()
    const { sent, fetch } = recorder(() =>
      json({
        label,
        hostnames: { lan: `lan.${label}.u.copse.me`, web: `web.${label}.u.copse.me` },
      }),
    )
    const client = new NamesClient({
      baseUrl: 'https://api.example.test/',
      key,
      fetch,
      now: (): number => 1_761_800_000_000,
    })
    const response = await client.register('invite-1')
    assert.equal(response.label, label)
    const request = sent[0]
    assert.ok(request)
    assert.equal(request.url, 'https://api.example.test/v1/register')
    assert.equal(request.method, 'POST')
    assert.equal(request.headers['content-type'], 'application/json')
    assert.equal(request.headers['copse-key'], key.thumbprint)
    assert.equal(request.headers['copse-timestamp'], '1761800000000')
    assert.deepEqual(JSON.parse(new TextDecoder().decode(request.body)), {
      publicKey: key.publicKey,
      invite: 'invite-1',
    })
    const text = await canonicalRequest({
      method: 'POST',
      path: '/v1/register',
      timestampMs: 1_761_800_000_000,
      nonce: request.headers['copse-nonce'] ?? '',
      body: request.body,
    })
    assert.equal(
      await verifyText(publicCryptoKey, text, request.headers['copse-signature'] ?? ''),
      true,
    )
  })

  it('signs a retry afresh instead of resending a spent nonce', async () => {
    const { key } = await deviceKey()
    const { sent, fetch } = recorder(() => new Response(null, { status: 204 }))
    const client = new NamesClient({ baseUrl: 'https://api.example.test', key, fetch })
    await client.setAddress('192.168.1.20')
    await client.setAddress('192.168.1.20')
    assert.equal(sent.length, 2)
    assert.notEqual(sent[0]?.headers['copse-nonce'], sent[1]?.headers['copse-nonce'])
    assert.notEqual(sent[0]?.headers['copse-signature'], sent[1]?.headers['copse-signature'])
  })

  it('sends bodiless GET and DELETE requests over an empty body', async () => {
    const { key } = await deviceKey()
    const { sent, fetch } = recorder((request) =>
      request.method === 'GET'
        ? json({
            label,
            state: 'active',
            lanAddress: null,
            lastRenewedAt: '2026-10-30T00:00:00Z',
            certificate: null,
          })
        : new Response(null, { status: 204 }),
    )
    const client = new NamesClient({ baseUrl: 'https://api.example.test', key, fetch })
    assert.equal((await client.status()).state, 'active')
    await client.remove()
    assert.deepEqual(
      sent.map((request) => [request.method, request.url, request.body.length]),
      [
        ['GET', 'https://api.example.test/v1/device', 0],
        ['DELETE', 'https://api.example.test/v1/device', 0],
      ],
    )
    assert.equal(sent[0]?.headers['content-type'], undefined)
  })

  it('base64url-encodes the CSR', async () => {
    const { key } = await deviceKey()
    const { sent, fetch } = recorder(() =>
      json({ chain: 'pem', notAfter: '2026-11-05T00:00:00Z', renewalWindow: null }),
    )
    const client = new NamesClient({ baseUrl: 'https://api.example.test', key, fetch })
    await client.certificate(Uint8Array.of(0xfb, 0xff))
    assert.deepEqual(JSON.parse(new TextDecoder().decode(sent[0]?.body)), { csr: '-_8' })
  })

  it('reports the service error, its code and Retry-After', async () => {
    const { key } = await deviceKey()
    const { fetch } = recorder(() =>
      json({ error: 'rate_limited', message: 'Too many orders today.' }, 429, {
        'retry-after': '120',
      }),
    )
    const client = new NamesClient({ baseUrl: 'https://api.example.test', key, fetch })
    await assert.rejects(client.certificate(utf8('x')), (error: unknown) => {
      assert.ok(error instanceof NamesApiError)
      assert.equal(error.status, 429)
      assert.equal(error.code, 'rate_limited')
      assert.equal(error.message, 'Too many orders today.')
      assert.equal(error.retryAfterSeconds, 120)
      return true
    })
  })

  it('treats an unreachable service as status 0 and a malformed reply as an error', async () => {
    const { key } = await deviceKey()
    const offline = new NamesClient({
      baseUrl: 'https://api.example.test',
      key,
      fetch: (): Promise<Response> => Promise.reject(new TypeError('fetch failed')),
    })
    await assert.rejects(
      offline.status(),
      (error: unknown) => error instanceof NamesApiError && error.status === 0,
    )
    const { fetch } = recorder(() => json({ label: 'NOT-A-LABEL' }))
    const garbled = new NamesClient({ baseUrl: 'https://api.example.test', key, fetch })
    await assert.rejects(garbled.status(), NamesApiError)
  })
})
