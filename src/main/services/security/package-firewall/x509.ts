import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

/**
 * Minimal X.509 issuance for the package firewall's TLS interception, built on
 * `node:crypto` and a small DER encoder instead of a certificate library.
 *
 * The firewall mints one certificate authority per invocation. Its private key
 * only ever lives in memory, and the CA carries a critical `nameConstraints`
 * extension that permits just the intercepted registry hosts — so even a leaked
 * key could not sign a certificate any verifier accepts for another site. Keys
 * are EC P-256 and certificates are signed with ECDSA/SHA-256.
 *
 * The extension set satisfies OpenSSL's `X509_V_FLAG_X509_STRICT` (on by
 * default in Python 3.13's `ssl`): critical basicConstraints and keyUsage on the
 * CA, a subjectKeyIdentifier on the CA and an authorityKeyIdentifier on leaves.
 */

const OID = {
  commonName: '2.5.4.3',
  organizationName: '2.5.4.10',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  nameConstraints: '2.5.29.30',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
} as const

const ORGANIZATION = 'Copse Package Firewall'
const CLOCK_SKEW_MS = 60 * 60 * 1000
const DEFAULT_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content)
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body])
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, ...items)
const set = (...items: Buffer[]): Buffer => tlv(0x31, ...items)
const octetString = (bytes: Buffer): Buffer => tlv(0x04, bytes)
const utf8String = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'))
const derTrue = Buffer.from([0x01, 0x01, 0xff])

/** A non-negative INTEGER from big-endian bytes, minimally encoded. */
function unsignedInteger(bytes: Buffer): Buffer {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  const trimmed = bytes.subarray(start)
  const needsPad = ((trimmed[0] ?? 0) & 0x80) !== 0
  return tlv(0x02, needsPad ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed)
}

function base128(value: number): number[] {
  const out = [value & 0x7f]
  for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) {
    out.unshift((rest & 0x7f) | 0x80)
  }
  return out
}

function objectIdentifier(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number)
  const bytes = [...base128(first * 40 + second), ...rest.flatMap(base128)]
  return tlv(0x06, Buffer.from(bytes))
}

/** BIT STRING holding a named-bit list such as keyUsage, trailing zero bits dropped. */
function namedBits(bits: readonly number[]): Buffer {
  const highest = Math.max(...bits)
  const bytes = Buffer.alloc(Math.floor(highest / 8) + 1)
  for (const bit of bits) {
    const index = Math.floor(bit / 8)
    bytes[index] = (bytes[index] ?? 0) | (0x80 >> (bit % 8))
  }
  const unused = 7 - (highest % 8)
  return tlv(0x03, Buffer.from([unused]), bytes)
}

/** RFC 5280: UTCTime through 2049, GeneralizedTime from 2050. */
function time(date: Date): Buffer {
  const digits = date.toISOString().slice(0, 19).replace(/[-:T]/g, '')
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${digits}Z`, 'ascii'))
}

function distinguishedName(commonName: string): Buffer {
  return sequence(
    set(sequence(objectIdentifier(OID.organizationName), utf8String(ORGANIZATION))),
    set(sequence(objectIdentifier(OID.commonName), utf8String(commonName))),
  )
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(objectIdentifier(id), ...(critical ? [derTrue] : []), octetString(value))
}

/** dNSName GeneralName (`[2] IMPLICIT IA5String`). */
function dnsName(host: string): Buffer {
  return tlv(0x82, Buffer.from(host, 'ascii'))
}

function randomSerial(): Buffer {
  const serial = randomBytes(16)
  // Positive and full-width: clear the sign bit, keep the top byte non-zero.
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x40
  return serial
}

function keyIdentifier(spki: Buffer): Buffer {
  return createHash('sha1').update(spki).digest()
}

function toPem(der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? []
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}

interface CertificateFields {
  issuer: Buffer
  subject: Buffer
  spki: Buffer
  notBefore: Date
  notAfter: Date
  extensions: Buffer[]
}

function signCertificate(fields: CertificateFields, issuerKey: KeyObject): Buffer {
  const algorithm = sequence(objectIdentifier(OID.ecdsaWithSha256))
  const tbs = sequence(
    tlv(0xa0, unsignedInteger(Buffer.from([2]))),
    unsignedInteger(randomSerial()),
    algorithm,
    fields.issuer,
    sequence(time(fields.notBefore), time(fields.notAfter)),
    fields.subject,
    fields.spki,
    tlv(0xa3, sequence(...fields.extensions)),
  )
  const signature = sign('sha256', tbs, issuerKey)
  return sequence(tbs, algorithm, tlv(0x03, Buffer.from([0]), signature))
}

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

function permits(permittedHosts: readonly string[], host: string): boolean {
  return permittedHosts.some((base) => host === base || host.endsWith(`.${base}`))
}

export interface IssuedCertificate {
  certPem: string
  keyPem: string
}

export interface CertificateAuthority {
  /** The CA certificate, for the trust bundle handed to child processes. */
  certPem: string
  /** Hosts (and their subdomains) the CA's name constraints permit. */
  permittedHosts: readonly string[]
  /** Issue a TLS server certificate for `host`, which must be permitted. */
  issue(host: string): IssuedCertificate
}

export interface CertificateAuthorityOptions {
  permittedHosts: readonly string[]
  commonName?: string
  now?: Date
  validityMs?: number
}

/** Mint an in-memory, name-constrained CA for one firewall invocation. */
export function createCertificateAuthority(
  options: CertificateAuthorityOptions,
): CertificateAuthority {
  const permittedHosts = options.permittedHosts.map((host) => host.toLowerCase())
  if (permittedHosts.length === 0 || !permittedHosts.every((host) => HOSTNAME_RE.test(host))) {
    throw new Error('A firewall CA needs at least one valid permitted hostname')
  }
  const now = options.now ?? new Date()
  const notBefore = new Date(now.getTime() - CLOCK_SKEW_MS)
  const notAfter = new Date(now.getTime() + (options.validityMs ?? DEFAULT_VALIDITY_MS))
  const caKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const caSpki = caKeys.publicKey.export({ type: 'spki', format: 'der' })
  const caKeyId = keyIdentifier(caSpki)
  const caName = distinguishedName(options.commonName ?? `${ORGANIZATION} (ephemeral)`)
  const caDer = signCertificate(
    {
      issuer: caName,
      subject: caName,
      spki: caSpki,
      notBefore,
      notAfter,
      extensions: [
        extension(OID.basicConstraints, true, sequence(derTrue, unsignedInteger(Buffer.from([0])))),
        // keyCertSign (5) + cRLSign (6).
        extension(OID.keyUsage, true, namedBits([5, 6])),
        extension(OID.subjectKeyIdentifier, false, octetString(caKeyId)),
        extension(OID.authorityKeyIdentifier, false, sequence(tlv(0x80, caKeyId))),
        extension(
          OID.nameConstraints,
          true,
          sequence(tlv(0xa0, ...permittedHosts.map((host) => sequence(dnsName(host))))),
        ),
      ],
    },
    caKeys.privateKey,
  )

  return {
    certPem: toPem(caDer),
    permittedHosts,
    issue(rawHost: string): IssuedCertificate {
      const host = rawHost.toLowerCase()
      if (!HOSTNAME_RE.test(host) || !permits(permittedHosts, host)) {
        throw new Error(`The firewall CA may not issue a certificate for ${rawHost}`)
      }
      const leafKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      const leafSpki = leafKeys.publicKey.export({ type: 'spki', format: 'der' })
      const leafDer = signCertificate(
        {
          issuer: caName,
          subject: distinguishedName(host),
          spki: leafSpki,
          notBefore,
          notAfter,
          extensions: [
            extension(OID.basicConstraints, true, sequence()),
            // digitalSignature (0).
            extension(OID.keyUsage, true, namedBits([0])),
            extension(OID.extKeyUsage, false, sequence(objectIdentifier(OID.serverAuth))),
            extension(OID.subjectAltName, false, sequence(dnsName(host))),
            extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier(leafSpki))),
            extension(OID.authorityKeyIdentifier, false, sequence(tlv(0x80, caKeyId))),
          ],
        },
        caKeys.privateKey,
      )
      const keyPem = leafKeys.privateKey.export({ type: 'pkcs8', format: 'pem' })
      return { certPem: toPem(leafDer), keyPem }
    },
  }
}
