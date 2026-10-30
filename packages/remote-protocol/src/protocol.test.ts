import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fromBase64Url, toBase64Url, utf8 } from './encoding.ts'
import { createGrant, GRANT_LIFETIME_MS, verifyGrantSignature } from './grant.ts'
import {
  DevicePublicKey,
  exportDevicePublicKey,
  generateDeviceKeyPair,
  importDevicePublicKey,
  keyThumbprint,
  verifyText,
} from './keys.ts'
import {
  CertificateRequest,
  CertificateResponse,
  DeviceStatusResponse,
  ErrorResponse,
  LabelGrant,
  RegisterRequest,
  RegisterResponse,
} from './messages.ts'
import {
  canonicalRequest,
  HEADER_KEY,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  newNonce,
  NONCE_PATTERN,
  signRequestHeaders,
  THUMBPRINT_PATTERN,
} from './signing.ts'
import { TunnelAuth, tunnelSigningText } from './tunnel.ts'

// RFC 7517 appendix A.1's example P-256 public key.
const RFC_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
  y: '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM',
} as const

const sha256Url = (text: string): string => createHash('sha256').update(text).digest('base64url')

describe('base64url', () => {
  it('round-trips bytes without padding', () => {
    const bytes = Uint8Array.of(0xfb, 0xff, 0x00, 0x10)
    const text = toBase64Url(bytes)
    assert.equal(text, '-_8AEA')
    assert.deepEqual(fromBase64Url(text), bytes)
  })

  it('refuses padding, the standard alphabet and impossible lengths', () => {
    assert.equal(fromBase64Url('-_8AEA=='), null)
    assert.equal(fromBase64Url('+/8AEA'), null)
    assert.equal(fromBase64Url('A'), null)
  })
})

describe('canonicalRequest', () => {
  it('joins the fixed fields with newlines and hashes the body', async () => {
    const body = '{"address":"192.168.1.20"}'
    const text = await canonicalRequest({
      method: 'post',
      path: '/v1/address',
      timestampMs: 1_761_800_000_000,
      nonce: 'AAAAAAAAAAAAAAAAAAAAAAAA',
      body: utf8(body),
    })
    assert.equal(
      text,
      [
        'copse-request-v1',
        'POST',
        '/v1/address',
        '1761800000000',
        'AAAAAAAAAAAAAAAAAAAAAAAA',
        sha256Url(body),
      ].join('\n'),
    )
  })

  it('hashes an empty body for bodiless requests', async () => {
    const text = await canonicalRequest({
      method: 'GET',
      path: '/v1/device?x=1',
      timestampMs: 5,
      nonce: 'BBBBBBBBBBBBBBBB',
      body: new Uint8Array(),
    })
    assert.equal(text.split('\n').at(-1), '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU')
    assert.equal(text.split('\n')[2], '/v1/device?x=1')
  })
})

describe('signRequestHeaders', () => {
  it('signs the canonical string with a fresh nonce, verifiable with the public key', async () => {
    const keys = await generateDeviceKeyPair()
    const thumbprint = await keyThumbprint(await exportDevicePublicKey(keys.publicKey))
    const body = utf8('{"csr":"x"}')
    const headers = await signRequestHeaders(
      keys.privateKey,
      thumbprint,
      'POST',
      '/v1/certificate',
      body,
      42,
    )
    assert.equal(headers[HEADER_KEY], thumbprint)
    assert.equal(headers[HEADER_TIMESTAMP], '42')
    const nonce = headers[HEADER_NONCE] ?? ''
    const signature = headers[HEADER_SIGNATURE] ?? ''
    assert.match(nonce, NONCE_PATTERN)
    // IEEE P1363: 64 bytes, so 86 base64url characters.
    assert.match(signature, /^[A-Za-z0-9_-]{86}$/)
    const text = await canonicalRequest({
      method: 'POST',
      path: '/v1/certificate',
      timestampMs: 42,
      nonce,
      body,
    })
    assert.equal(await verifyText(keys.publicKey, text, signature), true)
    assert.equal(await verifyText(keys.publicKey, `${text}x`, signature), false)
  })

  it('never reuses a nonce across signatures', async () => {
    const keys = await generateDeviceKeyPair()
    const a = await signRequestHeaders(keys.privateKey, 't', 'GET', '/v1/device', new Uint8Array())
    const b = await signRequestHeaders(keys.privateKey, 't', 'GET', '/v1/device', new Uint8Array())
    assert.notEqual(a[HEADER_NONCE], b[HEADER_NONCE])
  })
})

describe('nonce and thumbprint patterns', () => {
  it('accepts 16 to 64 base64url characters for a nonce', () => {
    assert.match(newNonce(), NONCE_PATTERN)
    assert.equal(newNonce().length, 24)
    assert.match('a'.repeat(16), NONCE_PATTERN)
    assert.match('a'.repeat(64), NONCE_PATTERN)
    assert.doesNotMatch('a'.repeat(15), NONCE_PATTERN)
    assert.doesNotMatch('a'.repeat(65), NONCE_PATTERN)
    assert.doesNotMatch(`${'a'.repeat(16)}=`, NONCE_PATTERN)
  })

  it('accepts exactly 43 base64url characters for a thumbprint', () => {
    assert.match('a'.repeat(43), THUMBPRINT_PATTERN)
    assert.doesNotMatch('a'.repeat(42), THUMBPRINT_PATTERN)
    assert.doesNotMatch('a'.repeat(44), THUMBPRINT_PATTERN)
  })
})

describe('keyThumbprint', () => {
  it('hashes the RFC 7638 members in lexicographic order', async () => {
    const expected = sha256Url(`{"crv":"P-256","kty":"EC","x":"${RFC_KEY.x}","y":"${RFC_KEY.y}"}`)
    const thumbprint = await keyThumbprint(DevicePublicKey.parse(RFC_KEY))
    assert.equal(thumbprint, expected)
    assert.match(thumbprint, THUMBPRINT_PATTERN)
  })

  it('names a generated key the same way after an export and re-import', async () => {
    const keys = await generateDeviceKeyPair()
    const publicKey = await exportDevicePublicKey(keys.publicKey)
    const imported = await importDevicePublicKey(publicKey)
    assert.ok(imported)
    assert.equal(
      await keyThumbprint(await exportDevicePublicKey(imported)),
      await keyThumbprint(publicKey),
    )
  })
})

describe('DevicePublicKey', () => {
  it('refuses a private member or an unknown field', () => {
    assert.equal(DevicePublicKey.safeParse(RFC_KEY).success, true)
    assert.equal(DevicePublicKey.safeParse({ ...RFC_KEY, d: RFC_KEY.x }).success, false)
    assert.equal(DevicePublicKey.safeParse({ ...RFC_KEY, kid: 'k' }).success, false)
    assert.equal(DevicePublicKey.safeParse({ ...RFC_KEY, crv: 'P-384' }).success, false)
  })

  it('imports as null when the point is not on the curve', async () => {
    const offCurve = DevicePublicKey.parse({ ...RFC_KEY, y: RFC_KEY.x })
    assert.equal(await importDevicePublicKey(offCurve), null)
  })
})

describe('names API messages', () => {
  const roundTrip = <T>(schema: { parse: (value: unknown) => T }, value: T): void => {
    assert.deepEqual(schema.parse(JSON.parse(JSON.stringify(value))), value)
  }
  const label = 'abcdefgh2345'

  it('round-trips every device endpoint body', () => {
    roundTrip(RegisterRequest, { publicKey: DevicePublicKey.parse(RFC_KEY), invite: 'inv-1' })
    roundTrip(RegisterResponse, {
      label,
      hostnames: { lan: `lan.${label}.u.copse.me`, web: `web.${label}.u.copse.me` },
    })
    roundTrip(CertificateRequest, { csr: 'MIIB' })
    roundTrip(CertificateResponse, {
      chain: '-----BEGIN CERTIFICATE-----\n',
      notAfter: '2026-11-05T00:00:00.000Z',
      renewalWindow: { start: '2026-11-02T00:00:00Z', end: '2026-11-03T00:00:00Z' },
    })
    roundTrip(CertificateResponse, { chain: 'c', notAfter: 'n', renewalWindow: null })
    roundTrip(DeviceStatusResponse, {
      label,
      state: 'active',
      lanAddress: '192.168.1.20',
      lastRenewedAt: '2026-10-30T00:00:00Z',
      certificate: { notAfter: '2026-11-05T00:00:00Z', renewalWindow: null },
    })
    roundTrip(DeviceStatusResponse, {
      label,
      state: 'dormant',
      lanAddress: null,
      lastRenewedAt: 'x',
      certificate: null,
    })
    roundTrip(ErrorResponse, { error: 'rate_limited', message: 'Try later' })
  })

  it('refuses extra fields, malformed labels and unknown states', () => {
    assert.equal(
      RegisterResponse.safeParse({ label, hostnames: { lan: 'a', web: 'b' }, extra: 1 }).success,
      false,
    )
    assert.equal(
      RegisterResponse.safeParse({ label: 'ABCDEFGH2345', hostnames: { lan: 'a', web: 'b' } })
        .success,
      false,
    )
    assert.equal(
      RegisterResponse.safeParse({ label: 'abcdefgh0189', hostnames: { lan: 'a', web: 'b' } })
        .success,
      false,
    )
    assert.equal(
      DeviceStatusResponse.safeParse({
        label,
        state: 'paused',
        lanAddress: null,
        lastRenewedAt: 'x',
        certificate: null,
      }).success,
      false,
    )
    assert.equal(RegisterRequest.safeParse({ publicKey: RFC_KEY, invite: '' }).success, false)
    assert.equal(CertificateRequest.safeParse({ csr: 'x'.repeat(8193) }).success, false)
  })
})

describe('label grants', () => {
  it('signs a grant the label key can verify, and nothing else', async () => {
    const keys = await generateDeviceKeyPair()
    const grant = await createGrant(keys.privateKey, 'abcdefgh2345', 1_000)
    assert.equal(grant.expiresMs, 1_000 + GRANT_LIFETIME_MS)
    assert.deepEqual(LabelGrant.parse(grant), grant)
    assert.equal(await verifyGrantSignature(keys.publicKey, grant), true)
    assert.equal(
      await verifyGrantSignature(keys.publicKey, { ...grant, expiresMs: grant.expiresMs + 1 }),
      false,
    )
    const other = await generateDeviceKeyPair()
    assert.equal(await verifyGrantSignature(other.publicKey, grant), false)
  })
})

describe('tunnel handshake', () => {
  it('signs the fixed tunnel string and validates the auth line', () => {
    assert.equal(tunnelSigningText('abcdefgh2345', 'c', 7), 'copse-tunnel-v1\nabcdefgh2345\nc\n7')
    assert.equal(
      TunnelAuth.safeParse({
        type: 'auth',
        label: 'abcdefgh2345',
        timestampMs: 7,
        signature: 'a'.repeat(86),
      }).success,
      true,
    )
    assert.equal(
      TunnelAuth.safeParse({ type: 'auth', label: 'abcdefgh2345', timestampMs: 7, signature: 'a' })
        .success,
      false,
    )
  })
})
