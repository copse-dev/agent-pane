import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { fromBase64Url } from '@copse/remote-protocol/encoding.ts'
import {
  DevicePublicKey,
  importDevicePublicKey,
  keyThumbprint,
  verifyText,
} from '@copse/remote-protocol/keys.ts'
import {
  AddressRequest,
  CertificateRequest,
  RegisterRequest,
} from '@copse/remote-protocol/messages.ts'
import { canonicalRequest } from '@copse/remote-protocol/signing.ts'
import { decodeWithSchema, safeJsonParse } from '../../../packages/std/src/safe-json.ts'
import { der, derInteger } from '../../../src/main/services/mobile/der.ts'

/**
 * A stand-in for the Copse names API on loopback HTTP, for the trusted-name
 * spec. It checks every request the way the live service does — the device
 * signature over the canonical string, a fresh nonce, a fresh timestamp — so
 * the spec proves the app's signing, not just its UI. Certificates come from a
 * throwaway CA whose root the spec trusts explicitly.
 */

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
const extension = (id: Buffer, value: Buffer, critical = false): Buffer =>
  sequence(id, ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value))

function pem(body: Buffer): string {
  return `-----BEGIN CERTIFICATE-----\n${body.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`
}

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

function csrPublicKey(csr: Buffer): KeyObject {
  const info = tlv(tlv(csr, 0).value, 0).value
  let offset = 0
  for (let i = 0; i < 2; i++) offset = tlv(info, offset).end
  return createPublicKey({ key: tlv(info, offset).raw, format: 'der', type: 'spki' })
}

function certificate(input: {
  issuer: string
  issuerKey: KeyObject
  subject: Buffer
  publicKey: KeyObject
  notBefore: number
  notAfter: number
  extensions: Buffer[]
}): string {
  const tbs = sequence(
    der(0xa0, derInteger(Buffer.from([2]))),
    derInteger(Buffer.concat([Buffer.from([1]), randomBytes(8)])),
    ecdsa,
    cn(input.issuer),
    sequence(utcTime(input.notBefore), utcTime(input.notAfter)),
    input.subject,
    input.publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(...input.extensions)),
  )
  const signature = sign('sha256', tbs, { key: input.issuerKey, dsaEncoding: 'der' })
  return pem(sequence(tbs, ecdsa, der(0x03, Buffer.from([0]), signature)))
}

export interface FakeNamesApi {
  url: string
  /** PEM of the CA that signs issued certificates; trust it to verify the Mac. */
  caPem: string
  label: string
  /** `METHOD path` of every request whose signature verified, in order. */
  verified: string[]
  /** Requests refused for a bad signature, timestamp or nonce. */
  refused: string[]
  addresses: string[]
  close: () => Promise<void>
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) if (Buffer.isBuffer(chunk)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

export async function startFakeNamesApi(options: {
  port: number
  invite: string
  label?: string
}): Promise<FakeNamesApi> {
  const label = options.label ?? 'abcdefgh2345'
  const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const now = Date.now()
  const caPem = certificate({
    issuer: 'Copse e2e names CA',
    issuerKey: ca.privateKey,
    subject: cn('Copse e2e names CA'),
    publicKey: ca.publicKey,
    notBefore: now - 3_600_000,
    notAfter: now + 30 * 86_400_000,
    extensions: [
      extension(oid(0x55, 0x1d, 0x13), sequence(der(0x01, Buffer.from([0xff]))), true),
      extension(oid(0x55, 0x1d, 0x0f), der(0x03, Buffer.from([1, 0x06])), true),
    ],
  })
  const devices = new Map<string, { publicKey: CryptoKey; registered: boolean }>()
  const nonces = new Set<string>()
  const state: FakeNamesApi = {
    url: `http://127.0.0.1:${String(options.port)}`,
    caPem,
    label,
    verified: [],
    refused: [],
    addresses: [],
    close: () => Promise.resolve(),
  }

  const server: Server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const reply = (status: number, value?: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(value === undefined ? '' : JSON.stringify(value))
      }
      const method = req.method ?? 'GET'
      const path = req.url ?? '/'
      const body = await readBody(req)
      const header = (name: string): string => {
        const value = req.headers[name]
        return typeof value === 'string' ? value : ''
      }
      const thumbprint = header('copse-key')
      const timestamp = Number(header('copse-timestamp'))
      const nonce = header('copse-nonce')
      const refuse = (reason: string): void => {
        state.refused.push(`${method} ${path}: ${reason}`)
        reply(401, { error: 'bad_signature', message: reason })
      }
      if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 300_000) {
        refuse('stale timestamp')
        return
      }
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || nonces.has(`${thumbprint}:${nonce}`)) {
        refuse('reused or malformed nonce')
        return
      }
      let device = devices.get(thumbprint)
      if (method === 'POST' && path === '/v1/register' && !device) {
        const request = safeJsonParse(body.toString('utf8'), decodeWithSchema(RegisterRequest))
        const key = request
          ? await importDevicePublicKey(DevicePublicKey.parse(request.publicKey))
          : null
        if (!request || !key || (await keyThumbprint(request.publicKey)) !== thumbprint) {
          refuse('key does not match its thumbprint')
          return
        }
        device = { publicKey: key, registered: false }
        devices.set(thumbprint, device)
      }
      if (!device) {
        refuse('unknown device')
        return
      }
      const text = await canonicalRequest({ method, path, timestampMs: timestamp, nonce, body })
      if (!(await verifyText(device.publicKey, text, header('copse-signature')))) {
        refuse('signature does not verify')
        return
      }
      nonces.add(`${thumbprint}:${nonce}`)
      state.verified.push(`${method} ${path}`)

      if (method === 'POST' && path === '/v1/register') {
        const request = safeJsonParse(body.toString('utf8'), decodeWithSchema(RegisterRequest))
        if (request?.invite !== options.invite || device.registered) {
          reply(403, { error: 'invalid_invite', message: 'That invite is not valid.' })
          return
        }
        device.registered = true
        reply(200, {
          label,
          hostnames: { lan: `lan.${label}.u.copse.me`, web: `web.${label}.u.copse.me` },
        })
        return
      }
      if (!device.registered) {
        reply(404, { error: 'not_found', message: 'Unknown device.' })
        return
      }
      if (method === 'POST' && path === '/v1/address') {
        const request = safeJsonParse(body.toString('utf8'), decodeWithSchema(AddressRequest))
        if (!request || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(request.address)) {
          reply(400, { error: 'invalid_address', message: 'Only RFC 1918 addresses.' })
          return
        }
        state.addresses.push(request.address)
        reply(204)
        return
      }
      if (method === 'POST' && path === '/v1/certificate') {
        const request = safeJsonParse(body.toString('utf8'), decodeWithSchema(CertificateRequest))
        const csr = request ? fromBase64Url(request.csr) : null
        if (!csr) {
          reply(400, { error: 'invalid_csr', message: 'Malformed CSR.' })
          return
        }
        const issuedAt = Date.now()
        const notAfter = issuedAt + 6 * 86_400_000
        const name = `*.${label}.u.copse.me`
        const leaf = certificate({
          issuer: 'Copse e2e names CA',
          issuerKey: ca.privateKey,
          subject: sequence(),
          publicKey: csrPublicKey(Buffer.from(csr)),
          notBefore: issuedAt - 60_000,
          notAfter,
          extensions: [
            extension(oid(0x55, 0x1d, 0x11), sequence(der(0x82, Buffer.from(name))), true),
            extension(
              oid(0x55, 0x1d, 0x25),
              sequence(oid(0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01)),
            ),
          ],
        })
        reply(200, {
          chain: `${leaf}${caPem}`,
          notAfter: new Date(notAfter).toISOString(),
          renewalWindow: {
            start: new Date(issuedAt + 3 * 86_400_000).toISOString(),
            end: new Date(issuedAt + 4 * 86_400_000).toISOString(),
          },
        })
        return
      }
      if (method === 'GET' && path === '/v1/device') {
        reply(200, {
          label,
          state: 'active',
          lanAddress: state.addresses.at(-1) ?? null,
          lastRenewedAt: new Date().toISOString(),
          certificate: null,
        })
        return
      }
      if (method === 'DELETE' && path === '/v1/device') {
        devices.delete(thumbprint)
        reply(204)
        return
      }
      reply(404, { error: 'not_found', message: 'No such endpoint.' })
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', () => {
      resolve()
    })
  })
  state.close = (): Promise<void> =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => {
        resolve()
      })
    })
  return state
}
