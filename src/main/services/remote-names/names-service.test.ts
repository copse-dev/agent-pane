import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CertificateResponse,
  DeviceStatusResponse,
  RegisterResponse,
} from '@copse/remote-protocol/messages.ts'
import type { SecretCipher } from '@copse/store-kit/secret-cipher.ts'
import { der, derInteger } from '../mobile/der.ts'
import { NamesApiError } from './names-client.ts'
import { RemoteNames, type RemoteNamesOptions } from './names-service.ts'

type Client = ReturnType<RemoteNamesOptions['client']>
import { NamesStore } from './names-store.ts'

const label = 'abcdefgh2345'
const lan = `lan.${label}.u.copse.me`
const DAY = 86_400_000

// --- A tiny CA that signs whatever key a CSR names, for one SAN. ----------------------------

const sequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts)
const oid = (...bytes: number[]): Buffer => der(0x06, Buffer.from(bytes))
const ecdsa = sequence(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02))
const cn = (value: string): Buffer =>
  sequence(der(0x31, sequence(oid(0x55, 0x04, 0x03), der(0x0c, Buffer.from(value)))))
const utcTime = (ms: number): Buffer =>
  der(
    0x17,
    Buffer.from(
      new Date(ms)
        .toISOString()
        .replace(/[-:T]/g, '')
        .replace(/\.\d{3}Z$/, 'Z')
        .slice(2),
    ),
  )

function tlv(bytes: Buffer, offset: number): { value: Buffer; end: number; raw: Buffer } {
  let length = bytes[offset + 1] ?? 0
  let header = 2
  if (length & 0x80) {
    const count = length & 0x7f
    length = 0
    for (let i = 0; i < count; i++) length = length * 256 + (bytes[offset + 2 + i] ?? 0)
    header += count
  }
  const end = offset + header + length
  return { value: bytes.subarray(offset + header, end), end, raw: bytes.subarray(offset, end) }
}

/** The SPKI of a CSR: CertificationRequest → info → third element. */
function csrPublicKey(csr: Uint8Array): KeyObject {
  const info = tlv(tlv(Buffer.from(csr), 0).value, 0).value
  let offset = 0
  for (let i = 0; i < 2; i++) offset = tlv(info, offset).end
  return createPublicKey({ key: tlv(info, offset).raw, format: 'der', type: 'spki' })
}

const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

function issue(subjectKey: KeyObject, name: string, notBefore: number, notAfter: number): string {
  const san = sequence(oid(0x55, 0x1d, 0x11), der(0x04, sequence(der(0x82, Buffer.from(name)))))
  const tbs = sequence(
    der(0xa0, derInteger(Buffer.from([2]))),
    derInteger(Buffer.concat([Buffer.from([1]), randomBytes(8)])),
    ecdsa,
    cn('Test CA'),
    sequence(utcTime(notBefore), utcTime(notAfter)),
    sequence(),
    subjectKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(san)),
  )
  const signature = sign('sha256', tbs, { key: ca.privateKey, dsaEncoding: 'der' })
  const body = sequence(tbs, ecdsa, der(0x03, Buffer.from([0]), signature))
  return `-----BEGIN CERTIFICATE-----\n${body.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`
}

// --- Fakes ----------------------------------------------------------------------------------

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`sealed:${text}`),
  decryptString: (data) => data.toString().replace(/^sealed:/, ''),
}

interface FakeApi {
  calls: string[]
  addresses: string[]
  register: (invite: string) => Promise<RegisterResponse>
  status: () => Promise<DeviceStatusResponse>
  certificate: (csr: Uint8Array) => Promise<CertificateResponse>
  remove: () => Promise<void>
}

function fakeApi(clock: { now: number }): FakeApi {
  const api: FakeApi = {
    calls: [],
    addresses: [],
    register: (): Promise<RegisterResponse> =>
      Promise.resolve({
        label,
        hostnames: { lan, web: `web.${label}.u.copse.me` },
      }),
    status: (): Promise<DeviceStatusResponse> =>
      Promise.resolve({
        label,
        state: 'active',
        lanAddress: api.addresses.at(-1) ?? null,
        lastRenewedAt: new Date(clock.now).toISOString(),
        certificate: null,
      }),
    certificate: (csr): Promise<CertificateResponse> =>
      Promise.resolve({
        chain: issue(
          csrPublicKey(csr),
          `*.${label}.u.copse.me`,
          clock.now - 60_000,
          clock.now + 6 * DAY,
        ),
        notAfter: new Date(clock.now + 6 * DAY).toISOString(),
        renewalWindow: null,
      }),
    remove: (): Promise<void> => Promise.resolve(),
  }
  return api
}

let directory = ''
let services: RemoteNames[] = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'copse-names-'))
  services = []
})

afterEach(() => {
  for (const service of services) service.stop()
  rmSync(directory, { recursive: true, force: true })
})

function service(
  api: FakeApi,
  clock: { now: number },
  overrides: { cipher?: SecretCipher | null; lookup?: (host: string) => Promise<string[]> } = {},
): RemoteNames {
  const store = new NamesStore(
    () => (overrides.cipher === undefined ? cipher : overrides.cipher),
    directory,
  )
  const names = new RemoteNames({
    store,
    serviceUrl: (): string => 'https://api.example.test',
    lookup: overrides.lookup ?? ((): Promise<string[]> => Promise.resolve(['192.168.1.20'])),
    now: (): number => clock.now,
    random: (): number => 0,
    onChange: (): void => undefined,
    client: (): Client => ({
      register: async (invite): Promise<RegisterResponse> => {
        api.calls.push(`register:${invite}`)
        return await api.register(invite)
      },
      setAddress: (address): Promise<void> => {
        api.calls.push(`address:${address}`)
        api.addresses.push(address)
        return Promise.resolve()
      },
      certificate: async (csr): Promise<CertificateResponse> => {
        api.calls.push('certificate')
        return await api.certificate(csr)
      },
      status: async (): Promise<DeviceStatusResponse> => {
        api.calls.push('status')
        return await api.status()
      },
      remove: (): Promise<void> => {
        api.calls.push('remove')
        return api.remove()
      },
    }),
  })
  services.push(names)
  return names
}

async function settle(names: RemoteNames): Promise<void> {
  // Queue a no-op behind any work timers or address changes started.
  await names.recheckDns()
}

describe('RemoteNames', () => {
  it('registers, publishes the LAN address and serves a certificate for the name', async () => {
    const clock = { now: Date.now() }
    const api = fakeApi(clock)
    const names = service(api, clock)
    names.setServerAddress('192.168.1.20')
    await names.register(' invite-1 ')
    await settle(names)

    assert.deepEqual(api.calls.slice(0, 3), [
      'register:invite-1',
      'address:192.168.1.20',
      'certificate',
    ])
    const state = names.state()
    assert.equal(state.state, 'active')
    assert.equal(state.hostname, lan)
    assert.equal(state.dns, 'ok')
    assert.equal(state.lastError, null)
    // No ARI window: renew at two thirds of the lifetime.
    const certificate = state.certificate
    assert.ok(certificate)
    assert.ok(certificate.renewAt !== null)
    const lifetime = certificate.notAfter - (clock.now - 60_000)
    assert.ok(Math.abs(certificate.renewAt - (clock.now - 60_000 + (lifetime * 2) / 3)) < 2_000)
    const identity = names.identity()
    assert.ok(identity)
    assert.equal(identity.hostname, lan)
    assert.match(identity.cert, /BEGIN CERTIFICATE/)

    const record = readFileSync(join(directory, 'device.json'), 'utf8')
    assert.match(record, /"sealedKey"/)
    assert.doesNotMatch(record, /"d":/)
    assert.equal(statSync(join(directory, 'tls-key.pem')).mode & 0o777, 0o600)
  })

  it('resumes after a restart without re-sending an unchanged address', async () => {
    const clock = { now: Date.now() }
    const api = fakeApi(clock)
    const first = service(api, clock)
    first.setServerAddress('192.168.1.20')
    await first.register('invite-1')
    first.stop()

    const second = service(api, clock)
    await second.start()
    second.setServerAddress('192.168.1.20')
    await settle(second)
    assert.deepEqual(
      api.calls.filter((call) => call.startsWith('address')),
      ['address:192.168.1.20'],
    )
    assert.equal(second.identity()?.hostname, lan)

    second.setServerAddress('10.0.0.7')
    await settle(second)
    assert.deepEqual(api.addresses, ['192.168.1.20', '10.0.0.7'])
  })

  it('orders a certificate on start when the stored one has expired', async () => {
    const clock = { now: Date.now() }
    const api = fakeApi(clock)
    const first = service(api, clock)
    await first.register('invite-1')
    first.stop()
    clock.now += 7 * DAY
    const second = service(api, clock)
    await second.start()
    assert.equal(second.identity(), null)
    for (let i = 0; i < 50 && api.calls.filter((call) => call === 'certificate').length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    await settle(second)
    assert.equal(api.calls.filter((call) => call === 'certificate').length, 2)
    assert.equal(second.identity()?.hostname, lan)
  })

  it('refuses a hostname the service did not derive from the label', async () => {
    const clock = { now: Date.now() }
    const api = fakeApi(clock)
    api.register = (): Promise<RegisterResponse> =>
      Promise.resolve({ label, hostnames: { lan: 'lan.attacker.example', web: 'w' } })
    const names = service(api, clock)
    await names.register('invite-1')
    assert.equal(names.state().state, 'unregistered')
    assert.match(names.state().lastError ?? '', /unexpected hostname/)
    assert.ok(!api.calls.includes('certificate'))
  })

  it('refuses a certificate for another name', async () => {
    const clock = { now: Date.now() }
    const api = fakeApi(clock)
    api.certificate = (csr): Promise<CertificateResponse> =>
      Promise.resolve({
        chain: issue(csrPublicKey(csr), '*.otherlabel23.u.copse.me', clock.now, clock.now + DAY),
        notAfter: new Date(clock.now + DAY).toISOString(),
        renewalWindow: null,
      })
    const names = service(api, clock)
    await names.register('invite-1')
    assert.equal(names.identity(), null)
    assert.match(names.state().lastError ?? '', /cannot use/)
    // Backs off rather than re-ordering at once.
    assert.ok((names.state().certificate?.renewAt ?? Infinity) >= clock.now)
  })

  it('stops at six orders a day', async () => {
    const clock = { now: Date.now() }
    const api = fakeApi(clock)
    api.certificate = (): Promise<CertificateResponse> =>
      Promise.reject(new NamesApiError('busy', 503, null, null))
    const first = service(api, clock)
    await first.register('invite-1')
    first.stop()
    // Each restart without a certificate orders at once, until the day's limit.
    for (let restart = 0; restart < 8; restart++) {
      const names = service(api, clock)
      await names.start()
      await new Promise((resolve) => setTimeout(resolve, 20))
      await settle(names)
      names.stop()
    }
    assert.equal(api.calls.filter((call) => call === 'certificate').length, 6)
  })

  it('never stores the device key without the keychain', async () => {
    const clock = { now: Date.now() }
    const api = fakeApi(clock)
    const names = service(api, clock, { cipher: null })
    await names.register('invite-1')
    assert.match(names.state().lastError ?? '', /keychain/)
    assert.deepEqual(api.calls, [])
    assert.throws(() => statSync(join(directory, 'device.json')))
  })

  it('recovers a registration whose reply was lost', async () => {
    const clock = { now: Date.now() }
    const api = fakeApi(clock)
    api.register = (): Promise<RegisterResponse> =>
      Promise.reject(new NamesApiError('offline', 0, null, null))
    const names = service(api, clock)
    // The first attempt registered on the service but its reply never arrived.
    await names.register('invite-1')
    assert.equal(names.state().state, 'unregistered')
    await names.register('invite-1')
    assert.equal(names.state().state, 'active')
    assert.equal(api.calls.filter((call) => call.startsWith('register')).length, 1)
  })

  it('explains a name the local resolver drops', async () => {
    const clock = { now: Date.now() }
    const api = fakeApi(clock)
    const blocked = service(api, clock, { lookup: () => Promise.resolve([]) })
    blocked.setServerAddress('192.168.1.20')
    await blocked.register('invite-1')
    await settle(blocked)
    assert.equal(blocked.state().dns, 'unresolved')
    blocked.stop()
    rmSync(join(directory, 'device.json'))

    const elsewhere = service(api, clock, { lookup: () => Promise.resolve(['10.9.9.9']) })
    elsewhere.setServerAddress('192.168.1.20')
    await elsewhere.register('invite-2')
    await settle(elsewhere)
    assert.equal(elsewhere.state().dns, 'mismatch')
  })

  it('deletes the device on the service and forgets it locally', async () => {
    const clock = { now: Date.now() }
    const api = fakeApi(clock)
    const names = service(api, clock)
    await names.register('invite-1')
    await names.remove()
    assert.ok(api.calls.includes('remove'))
    assert.equal(names.state().state, 'unregistered')
    assert.equal(names.identity(), null)
    assert.throws(() => statSync(join(directory, 'device.json')))
    assert.throws(() => statSync(join(directory, 'tls-key.pem')))
  })

  it('keeps the registration when the service cannot be reached to delete it', async () => {
    const clock = { now: Date.now() }
    const api = fakeApi(clock)
    const names = service(api, clock)
    await names.register('invite-1')
    api.remove = (): Promise<void> => Promise.reject(new NamesApiError('offline', 0, null, null))
    await names.remove()
    assert.equal(names.state().state, 'active')
    assert.match(names.state().lastError ?? '', /offline/)
    api.remove = (): Promise<void> =>
      Promise.reject(new NamesApiError('gone', 404, 'not_found', null))
    await names.remove()
    assert.equal(names.state().state, 'unregistered')
  })
})
