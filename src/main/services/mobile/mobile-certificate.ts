import {
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
  X509Certificate,
} from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { copseDataRoot } from '../storage/copse-paths.ts'
import { der, derInteger, positiveSerial } from './der.ts'

// The certificate profile is deliberately small. All DER values below have one
// fixed shape; no untrusted ASN.1 is decoded or re-encoded here.
const sequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts)
const oid = (...bytes: number[]): Buffer => der(0x06, Buffer.from(bytes))
const integer = derInteger
const bool = (): Buffer => der(0x01, Buffer.from([0xff]))
const octets = (value: Buffer): Buffer => der(0x04, value)
const utf8 = (value: string): Buffer => der(0x0c, Buffer.from(value, 'utf8'))
const ecSignature = sequence(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02))
const commonName = (value: string): Buffer =>
  sequence(der(0x31, sequence(oid(0x55, 0x04, 0x03), utf8(value))))

function extension(id: number[], value: Buffer, critical = false): Buffer {
  return sequence(oid(...id), ...(critical ? [bool()] : []), octets(value))
}

function validity(from: Date, until: Date): Buffer {
  const stamp = (date: Date): Buffer => {
    const year = date.getUTCFullYear()
    // RFC 5280 requires UTCTime through 2049; Apple rejects GeneralizedTime
    // for those dates even though OpenSSL accepts it.
    const value = date
      .toISOString()
      .replace(/[-:T]/g, '')
      .replace(/\.\d{3}Z$/, 'Z')
    return der(
      year >= 1950 && year < 2050 ? 0x17 : 0x18,
      Buffer.from(year >= 1950 && year < 2050 ? value.slice(2) : value, 'ascii'),
    )
  }
  return sequence(stamp(from), stamp(until))
}

function ipBytes(address: string): Buffer {
  const parts = address.split('.')
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
  ) {
    throw new Error('Expected a canonical IPv4 address')
  }
  return Buffer.from(parts.map(Number))
}

function nameConstraints(): Buffer {
  const ip = (network: string, mask: string): Buffer =>
    sequence(der(0x87, ipBytes(network), ipBytes(mask)))
  const permitted = der(
    0xa0,
    ip('10.0.0.0', '255.0.0.0'),
    ip('172.16.0.0', '255.240.0.0'),
    ip('192.168.0.0', '255.255.0.0'),
    sequence(der(0x82, Buffer.from('copse.invalid', 'ascii'))),
  )
  return sequence(permitted)
}

function certificate(input: {
  subject: string
  issuer: string
  publicKey: Buffer
  issuerKey: string
  validDays: number
  extensions: Buffer[]
}): string {
  const now = Date.now()
  const serial = positiveSerial(() => randomBytes(16))
  const tbs = sequence(
    der(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    ecSignature,
    commonName(input.issuer),
    validity(new Date(now - 60_000), new Date(now + input.validDays * 86_400_000)),
    commonName(input.subject),
    input.publicKey,
    der(0xa3, sequence(...input.extensions)),
  )
  const signer = createSign('SHA256')
  signer.update(tbs)
  const signature = signer.sign(input.issuerKey)
  const bytes = sequence(tbs, ecSignature, der(0x03, Buffer.from([0]), signature))
  const lines = bytes
    .toString('base64')
    .replace(/.{1,64}/g, '$&\n')
    .trimEnd()
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`
}

function keyPair(): { privateKey: string; publicKey: Buffer } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }),
  }
}

export interface MobileCertificate {
  root: string
  cert: string
  key: string
  rootPath: string
}

export function mobileCertificate(
  address: string,
  directory = join(copseDataRoot(), 'lan'),
): MobileCertificate {
  const ip = ipBytes(address)
  // The certificate may vouch only for RFC1918 literals. The listener makes
  // the same check independently before it binds.
  if (
    !(
      ip[0] === 10 ||
      (ip[0] === 172 && (ip[1] ?? 0) >= 16 && (ip[1] ?? 0) <= 31) ||
      (ip[0] === 192 && ip[1] === 168)
    )
  ) {
    throw new Error('Mobile Companion requires an RFC1918 address')
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const rootPath = join(directory, 'ca.crt')
  const keyPath = join(directory, 'ca.key')
  let root: string
  let rootKey: string
  try {
    root = readFileSync(rootPath, 'utf8')
    rootKey = readFileSync(keyPath, 'utf8')
    const parsed = new X509Certificate(root)
    if (!parsed.verify(createPublicKey(rootKey)) || !parsed.ca)
      throw new Error('Invalid Copse LAN root')
  } catch (error) {
    if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error
    const pair = keyPair()
    rootKey = pair.privateKey
    root = certificate({
      subject: 'Copse Local Root',
      issuer: 'Copse Local Root',
      publicKey: pair.publicKey,
      issuerKey: rootKey,
      validDays: 3650,
      extensions: [
        extension([0x55, 0x1d, 0x13], sequence(bool(), integer(Buffer.from([0]))), true),
        extension([0x55, 0x1d, 0x0f], der(0x03, Buffer.from([1, 0x06])), true),
        extension([0x55, 0x1d, 0x1e], nameConstraints(), true),
      ],
    })
    writeFileSync(keyPath, rootKey, { mode: 0o600, flag: 'wx' })
    writeFileSync(rootPath, root, { mode: 0o600, flag: 'wx' })
  }
  const leaf = keyPair()
  const cert = certificate({
    subject: 'Copse Mobile Companion',
    issuer: 'Copse Local Root',
    publicKey: leaf.publicKey,
    issuerKey: rootKey,
    validDays: 30,
    extensions: [
      extension([0x55, 0x1d, 0x13], sequence(), true),
      extension([0x55, 0x1d, 0x0f], der(0x03, Buffer.from([7, 0x80])), true),
      extension([0x55, 0x1d, 0x25], sequence(oid(0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01))),
      extension([0x55, 0x1d, 0x11], sequence(der(0x87, ip))),
    ],
  })
  return { root, cert: `${cert}${root}`, key: leaf.privateKey, rootPath }
}

/** A private pinned identity for Copse-to-Copse model calls; never installed as a trusted CA. */
export function createMachineCertificate(): { cert: string; key: string } {
  const pair = keyPair()
  return {
    key: pair.privateKey,
    cert: certificate({
      subject: 'Copse Machine',
      issuer: 'Copse Machine',
      publicKey: pair.publicKey,
      issuerKey: pair.privateKey,
      validDays: 3650,
      extensions: [
        extension([0x55, 0x1d, 0x13], sequence(), true),
        extension([0x55, 0x1d, 0x0f], der(0x03, Buffer.from([7, 0x80])), true),
        extension(
          [0x55, 0x1d, 0x25],
          sequence(oid(0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01)),
        ),
      ],
    }),
  }
}
