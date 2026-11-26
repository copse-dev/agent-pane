import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { der, derInteger } from '../../src/main/services/mobile/der.ts'

/**
 * Throwaway ECDSA P-256 certificate authorities for tests that need real TLS:
 * the stand-in names API issues device certificates from one, and the relay
 * tests serve the relay's own name from another. Nothing here is trusted
 * outside the test that made it.
 */

const sequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts)
const oid = (...bytes: number[]): Buffer => der(0x06, Buffer.from(bytes))
const ecdsaWithSha256 = sequence(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02))
const commonName = (value: string): Buffer =>
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
    ecdsaWithSha256,
    commonName(input.issuer),
    sequence(utcTime(input.notBefore), utcTime(input.notAfter)),
    input.subject,
    input.publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(...input.extensions)),
  )
  const signature = sign('sha256', tbs, { key: input.issuerKey, dsaEncoding: 'der' })
  return pem(sequence(tbs, ecdsaWithSha256, der(0x03, Buffer.from([0]), signature)))
}

export interface TestCa {
  name: string
  /** The root, to pass as a client's `ca` or write to a file a client trusts. */
  pem: string
  privateKey: KeyObject
}

export function createTestCa(name: string, nowMs = Date.now()): TestCa {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    name,
    privateKey: pair.privateKey,
    pem: certificate({
      issuer: name,
      issuerKey: pair.privateKey,
      subject: commonName(name),
      publicKey: pair.publicKey,
      notBefore: nowMs - 3_600_000,
      notAfter: nowMs + 30 * 86_400_000,
      extensions: [
        extension(oid(0x55, 0x1d, 0x13), sequence(der(0x01, Buffer.from([0xff]))), true),
        extension(oid(0x55, 0x1d, 0x0f), der(0x03, Buffer.from([1, 0x06])), true),
      ],
    }),
  }
}

/** A server-auth leaf for `dnsNames` over `publicKey`, signed by `ca`. */
export function issueTestCertificate(
  ca: TestCa,
  options: { publicKey: KeyObject; dnsNames: string[]; notBefore?: number; notAfter?: number },
): string {
  const now = Date.now()
  return certificate({
    issuer: ca.name,
    issuerKey: ca.privateKey,
    subject: sequence(),
    publicKey: options.publicKey,
    notBefore: options.notBefore ?? now - 60_000,
    notAfter: options.notAfter ?? now + 6 * 86_400_000,
    extensions: [
      extension(
        oid(0x55, 0x1d, 0x11),
        sequence(...options.dnsNames.map((name) => der(0x82, Buffer.from(name)))),
        true,
      ),
      extension(
        oid(0x55, 0x1d, 0x25),
        sequence(oid(0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01)),
      ),
    ],
  })
}

/** A fresh key and a chain (leaf, then root) for a TLS server named `dnsNames`. */
export function testServerIdentity(ca: TestCa, dnsNames: string[]): { key: string; cert: string } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    key: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    cert: `${issueTestCertificate(ca, { publicKey: pair.publicKey, dnsNames })}${ca.pem}`,
  }
}
