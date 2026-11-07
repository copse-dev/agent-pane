import { generateKeyPairSync, sign } from 'node:crypto'
import { der, derInteger } from '../mobile/der.ts'

/** The zone the names service publishes device hostnames under. */
export const DEVICE_ZONE = 'u.copse.me'
const LABEL_PATTERN = /^[a-z2-7]{12}$/

// One fixed CSR shape, matching what the names service accepts: version 0, an
// empty subject, a P-256 key, and an extensionRequest whose only extension is a
// SAN holding exactly the label's wildcard. No untrusted ASN.1 is decoded here.
const sequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts)
const set = (...parts: Buffer[]): Buffer => der(0x31, ...parts)
const oid = (...bytes: number[]): Buffer => der(0x06, Buffer.from(bytes))
const EXTENSION_REQUEST = oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x0e)
const SUBJECT_ALT_NAME = oid(0x55, 0x1d, 0x11)
const ECDSA_WITH_SHA256 = sequence(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02))

/** The only certificate name the service issues for a label. */
export function certificateNameFor(label: string): string {
  if (!LABEL_PATTERN.test(label)) throw new Error('Invalid Copse name label')
  return `*.${label}.${DEVICE_ZONE}`
}

export interface CertificateRequestKey {
  /** PKCS#10, DER. */
  csr: Buffer
  /** The fresh TLS key the CSR names, PKCS#8 PEM. It never leaves this Mac. */
  privateKeyPem: string
}

/** A fresh TLS key and a CSR for `*.<label>.u.copse.me`, signed by that key. */
export function createCertificateRequest(label: string): CertificateRequestKey {
  const name = certificateNameFor(label)
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const san = sequence(SUBJECT_ALT_NAME, der(0x04, sequence(der(0x82, Buffer.from(name, 'ascii')))))
  const info = sequence(
    derInteger(Buffer.from([0])),
    sequence(),
    pair.publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa0, sequence(EXTENSION_REQUEST, set(sequence(san)))),
  )
  const signature = sign('sha256', info, { key: pair.privateKey, dsaEncoding: 'der' })
  return {
    csr: sequence(info, ECDSA_WITH_SHA256, der(0x03, Buffer.from([0]), signature)),
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }
}
