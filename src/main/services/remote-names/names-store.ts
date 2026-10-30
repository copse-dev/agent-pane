import { randomUUID, X509Certificate, createPrivateKey } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  exportDevicePublicKey,
  generateDeviceKeyPair,
  keyThumbprint,
} from '@copse/remote-protocol/keys.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import type { SecretCipher } from '@copse/store-kit/secret-cipher.ts'
import { copseDataRoot } from '../storage/copse-paths.ts'
import type { NamesDeviceKey } from './names-client.ts'
import type { IssuedCertificate } from './names-renewal.ts'

const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const privateJwkSchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: coordinate,
  y: coordinate,
  d: coordinate,
})
const label = z.string().regex(/^[a-z2-7]{12}$/)

const recordSchema = z.strictObject({
  v: z.literal(1),
  /** The names API this key registered with; a registration belongs to one service. */
  api: z.url({ protocol: /^https?$/ }),
  /** The device's private JWK, sealed by the OS keyring cipher. Never stored in the clear. */
  sealedKey: z.string().min(1),
  registration: z.strictObject({ label, lan: z.string(), web: z.string() }).nullable(),
  /** The last LAN address the service accepted, so a restart does not re-send it. */
  lastAddress: z.string().nullable(),
  /** When each recent certificate order was sent, for the six-per-day limit. */
  orders: z.array(z.number().int()).max(64),
  certificate: z
    .strictObject({
      notBeforeMs: z.number(),
      notAfterMs: z.number(),
      renewalWindow: z.strictObject({ startMs: z.number(), endMs: z.number() }).nullable(),
    })
    .nullable(),
})
export type NamesRecord = z.infer<typeof recordSchema>

export interface StoredCertificate extends IssuedCertificate {
  chainPem: string
  keyPem: string
}

const ALGORITHM: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' }

/**
 * `~/.copse/names/`: one record for the device and its registration, and the
 * current TLS key and chain. Kept apart from `config.json` and its renderer
 * writes, like the LAN companion's own files: the record names the service a
 * signed request goes to, and the device key never leaves the keyring seal.
 */
export class NamesStore {
  private readonly cipher: () => SecretCipher | null
  private readonly directory: string
  private readonly recordPath: string
  private readonly keyPath: string
  private readonly chainPath: string

  constructor(cipher: () => SecretCipher | null, directory = join(copseDataRoot(), 'names')) {
    this.cipher = cipher
    this.directory = directory
    this.recordPath = join(directory, 'device.json')
    this.keyPath = join(directory, 'tls-key.pem')
    this.chainPath = join(directory, 'tls-chain.pem')
  }

  read(): NamesRecord | null {
    let text: string
    try {
      text = readFileSync(this.recordPath, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
    const record = safeJsonParse(text, decodeWithSchema(recordSchema))
    if (!record) throw new Error('The Copse name record is unreadable')
    return record
  }

  write(record: NamesRecord): void {
    this.atomic(this.recordPath, `${JSON.stringify(record, null, 2)}\n`)
  }

  /** A new device key, sealed for storage. Refuses rather than store it in the clear. */
  async createKey(): Promise<{ key: NamesDeviceKey; sealedKey: string }> {
    const cipher = this.sealer()
    const pair = await generateDeviceKeyPair()
    const jwk = privateJwkSchema.parse(await crypto.subtle.exportKey('jwk', pair.privateKey))
    const sealedKey = cipher.encryptString(JSON.stringify(jwk)).toString('base64')
    const publicKey = await exportDevicePublicKey(pair.publicKey)
    return {
      key: { privateKey: pair.privateKey, publicKey, thumbprint: await keyThumbprint(publicKey) },
      sealedKey,
    }
  }

  async openKey(sealedKey: string): Promise<NamesDeviceKey> {
    const cipher = this.sealer()
    const jwk = safeJsonParse(
      cipher.decryptString(Buffer.from(sealedKey, 'base64')),
      decodeWithSchema(privateJwkSchema),
    )
    if (!jwk) throw new Error('The Copse device key is unreadable')
    const { d: _private, ...publicJwk } = jwk
    const privateKey = await crypto.subtle.importKey('jwk', jwk, ALGORITHM, false, ['sign'])
    const publicCryptoKey = await crypto.subtle.importKey('jwk', publicJwk, ALGORITHM, true, [
      'verify',
    ])
    const publicKey = await exportDevicePublicKey(publicCryptoKey)
    return { privateKey, publicKey, thumbprint: await keyThumbprint(publicKey) }
  }

  /** The stored TLS identity, or null when absent or no longer a matching pair. */
  readCertificate(meta: NamesRecord['certificate']): StoredCertificate | null {
    if (!meta) return null
    try {
      const keyPem = readFileSync(this.keyPath, 'utf8')
      const chainPem = readFileSync(this.chainPath, 'utf8')
      if (!new X509Certificate(chainPem).checkPrivateKey(createPrivateKey(keyPem))) return null
      return { ...meta, chainPem, keyPem }
    } catch {
      return null
    }
  }

  writeCertificate(chainPem: string, keyPem: string): void {
    this.atomic(this.keyPath, keyPem)
    this.atomic(this.chainPath, chainPem)
  }

  /** Forget everything: the device key, the registration and the TLS identity. */
  clear(): void {
    rmSync(this.recordPath, { force: true })
    rmSync(this.keyPath, { force: true })
    rmSync(this.chainPath, { force: true })
  }

  private sealer(): SecretCipher {
    const cipher = this.cipher()
    if (!cipher?.isEncryptionAvailable())
      throw new Error(
        'Copse cannot reach the system keychain to protect this Mac’s device key. Unlock the keychain and try again.',
      )
    return cipher
  }

  private atomic(path: string, text: string): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  }
}
