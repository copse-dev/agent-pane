import {
  VaultError,
  verifyManifest,
  openVaultRecord,
  sealVaultRecord,
  type VaultManifest,
  type SecretRecordIdentity,
} from './profile-vault-crypto.ts'

export interface VaultUnlockBackend {
  /** Returns a newly owned buffer. The session clears it, including late results. */
  unlock(signal: AbortSignal): Promise<Buffer>
}
/** Explicit, coalesced unlock; lock invalidates pending work before clearing the key. */
export class ProfileVaultSession {
  readonly #manifest: VaultManifest
  readonly #backend: VaultUnlockBackend
  #key: Buffer | null = null
  #pending: Promise<void> | null = null
  #controller: AbortController | null = null
  #generation = 0
  constructor(manifest: VaultManifest, backend: VaultUnlockBackend) {
    this.#manifest = structuredClone(manifest)
    this.#backend = backend
  }
  get status(): 'locked' | 'unlocking' | 'unlocked' {
    return this.#key ? 'unlocked' : this.#pending ? 'unlocking' : 'locked'
  }
  unlock(): Promise<void> {
    if (this.#key) return Promise.resolve()
    if (this.#pending) return this.#pending
    const generation = this.#generation
    const controller = new AbortController()
    this.#controller = controller
    const pending = Promise.resolve()
      .then(async () => {
        const key = await this.#backend.unlock(controller.signal)
        try {
          if (generation !== this.#generation || controller.signal.aborted)
            throw new VaultError('cancelled')
          verifyManifest(key, this.#manifest)
          this.#key = Buffer.from(key)
        } finally {
          key.fill(0)
        }
      })
      .finally(() => {
        if (this.#pending === pending) {
          this.#pending = null
          this.#controller = null
        }
      })
    this.#pending = pending
    return pending
  }
  lock(): void {
    this.#generation++
    this.#controller?.abort()
    this.#controller = null
    this.#pending = null
    this.#key?.fill(0)
    this.#key = null
  }
  encrypt(value: string, record: SecretRecordIdentity): Buffer {
    if (!this.#key) throw new VaultError('locked')
    return sealVaultRecord(this.#key, this.#manifest, record, value)
  }
  decrypt(value: Buffer, record: SecretRecordIdentity): string {
    if (!this.#key) throw new VaultError('locked')
    return openVaultRecord(this.#key, this.#manifest, record, value)
  }
}
