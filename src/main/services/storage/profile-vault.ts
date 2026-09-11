import { acquireVaultMaintenance } from '@copse/store-kit/profile-vault-access.ts'
import type { ProfileVaultStatus } from '@shared/types/profile-vault.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ProfileVaultSession } from '@copse/store-kit/profile-vault-session.ts'
import {
  callNativeVault,
  nativeRequest,
  type NativeVaultReply,
  type NativeVaultRequest,
} from '@copse/store-kit/profile-vault-native.ts'
import {
  authenticateManifest,
  createVaultManifest,
  newVaultIdentity,
  verifyManifest,
  VaultError,
  type VaultManifest,
} from '@copse/store-kit/profile-vault-crypto.ts'
import {
  commitVaultMigration,
  readVaultManifest,
  readVaultSource,
  writeVaultFile,
} from '@copse/store-kit/profile-vault-files.ts'
import { migrateVaultStores } from '@copse/store-kit/profile-vault-migration.ts'
import type { SecretCipher } from './secret-cipher.ts'

export interface ProfileVaultDependencies {
  userData: string
  legacy: SecretCipher
  invoke: (request: NativeVaultRequest, signal?: AbortSignal) => Promise<NativeVaultReply>
  /** Refuse active work and drain writes; called again immediately before the synchronous commit. */
  beforeMigration: () => Promise<void>
  /** Discard cached stores/credentials after storage changes or profile loss. */
  restart: () => void
}
export class AppProfileVault {
  readonly #deps: ProfileVaultDependencies
  #manifest: VaultManifest | null
  #session: ProfileVaultSession | null = null
  #busy = false
  #operation: AbortController | null = null
  #startup: Promise<boolean> | null = null
  #migrationFailed = false
  readonly cipher: SecretCipher
  constructor(dependencies: ProfileVaultDependencies) {
    this.#deps = dependencies
    this.#manifest = readVaultManifest(dependencies.userData)
    if (this.#manifest) this.#installSession(this.#manifest)
    const vault = this
    this.cipher = {
      get protection(): SecretCipher['protection'] {
        return vault.#manifest || vault.#busy ? 'device-vault' : undefined
      },
      isEncryptionAvailable: (): boolean =>
        !this.#busy &&
        (this.#session
          ? this.#session.status === 'unlocked'
          : dependencies.legacy.isEncryptionAvailable()),
      encryptString: (text, identity): Buffer => {
        if (this.#busy) throw new VaultError('locked')
        if (!this.#session) return dependencies.legacy.encryptString(text, identity)
        if (!identity) throw new VaultError('unsupported')
        return this.#session.encrypt(text, identity)
      },
      decryptString: (bytes, identity): string => {
        if (this.#busy) throw new VaultError('locked')
        if (!this.#session) return dependencies.legacy.decryptString(bytes, identity)
        if (!identity) throw new VaultError('unsupported')
        return this.#session.decrypt(bytes, identity)
      },
      shouldReencrypt: (bytes): boolean =>
        !this.#manifest && !this.#busy && (dependencies.legacy.shouldReencrypt?.(bytes) ?? false),
      encryptStringForMigration: (text): Buffer => {
        if (this.#manifest || this.#busy) throw new VaultError('unsupported')
        return (
          dependencies.legacy.encryptStringForMigration?.(text) ??
          dependencies.legacy.encryptString(text)
        )
      },
    }
  }
  #installSession(manifest: VaultManifest): void {
    this.#session?.lock()
    this.#manifest = manifest
    this.#session = new ProfileVaultSession(manifest, {
      unlock: async (signal): Promise<Buffer> => {
        const reply = await this.#deps.invoke(
          nativeRequest('unlock', this.#deps.userData, manifest),
          signal,
        )
        const key = this.#key(reply)
        try {
          if (signal.aborted) throw new VaultError('cancelled')
          this.#synchronizeEnvelope(key, reply)
          return key
        } catch (error) {
          key.fill(0)
          throw error
        }
      },
    })
  }
  #key(reply: NativeVaultReply): Buffer {
    if (!reply.ok || !reply.dataKey) throw new VaultError('corrupt')
    const key = Buffer.from(reply.dataKey, 'base64')
    delete reply.dataKey
    if (key.length !== 32) {
      key.fill(0)
      throw new VaultError('corrupt')
    }
    return key
  }
  #synchronizeEnvelope(key: Buffer, reply: NativeVaultReply): void {
    const manifest = this.#manifest
    if (!manifest) throw new VaultError('corrupt')
    verifyManifest(key, manifest)
    if (!reply.deviceKeyId || !reply.deviceEnvelope) return
    const updated = authenticateManifest(key, {
      ...manifest,
      deviceKeyId: reply.deviceKeyId,
      deviceEnvelope: reply.deviceEnvelope,
      requireAuth: reply.requireAuth ?? true,
    })
    // Native state is authoritative. A policy change can commit there before the
    // app writes its mirror; the next unlock repairs the mirror after a crash.
    if (JSON.stringify(updated) !== JSON.stringify(manifest)) {
      writeVaultFile(this.#deps.userData, 'vault-manifest.json', JSON.stringify(updated))
      this.#manifest = updated
    }
  }
  async status(): Promise<ProfileVaultStatus> {
    let reply: NativeVaultReply = { ok: false }
    try {
      reply = await this.#deps.invoke(
        nativeRequest('status', this.#deps.userData, this.#manifest ?? newVaultIdentity()),
      )
    } catch {
      /* Status probes never prompt or weaken encryption. */
    }
    return {
      state: this.#busy
        ? 'busy'
        : !reply.ok
          ? 'unavailable'
          : (this.#session?.status ?? 'disabled'),
      recovery: this.#manifest?.recovery ?? 'not-backed-up',
      available: reply.ok,
      enabled: this.#manifest !== null,
      requireAuth: reply.requireAuth ?? this.#manifest?.requireAuth ?? true,
      automatic: reply.automatic === true,
      migrationFailed: this.#migrationFailed,
    }
  }
  async unlock(): Promise<void> {
    if (this.#busy || !this.#session) throw new VaultError('unavailable')
    await this.#session.unlock()
  }
  /** Initialize before credential consumers. True means migration requested a restart.
   * One attempt per process; cancellation/failure never starts a prompt loop.
   */
  initialize(): Promise<boolean> {
    this.#startup ??= this.#initialize()
    return this.#startup
  }
  async #initialize(): Promise<boolean> {
    if (this.#manifest) {
      await this.unlock()
      return false
    }
    const status = await this.status()
    if (!status.available || !status.automatic) return false
    await this.migrate()
    return true
  }
  lock(): void {
    this.#operation?.abort()
    this.#session?.lock()
    if (this.#manifest) this.#deps.restart()
  }
  dispose(): void {
    this.#operation?.abort()
    this.#session?.lock()
  }
  async migrate(): Promise<void> {
    if (this.#busy || this.#manifest) throw new VaultError('unsupported')
    this.#busy = true
    const operation = new AbortController()
    this.#operation = operation
    let key: Buffer | null = null
    let releaseMaintenance: (() => void) | undefined
    try {
      const support = await this.#deps.invoke(
        nativeRequest('status', this.#deps.userData, newVaultIdentity()),
        operation.signal,
      )
      if (!support.ok || !support.automatic) throw new VaultError('unavailable')
      releaseMaintenance = acquireVaultMaintenance(this.#deps.userData)
      await this.#deps.beforeMigration()
      const identity = newVaultIdentity()
      const reply = await this.#deps.invoke(
        nativeRequest('create', this.#deps.userData, identity),
        operation.signal,
      )
      key = this.#key(reply)
      if (!reply.deviceKeyId || !reply.deviceEnvelope) throw new VaultError('corrupt')
      if (reply.requireAuth !== false) throw new VaultError('corrupt')
      const manifest = authenticateManifest(key, {
        ...createVaultManifest(key, identity, reply.deviceKeyId, reply.deviceEnvelope),
        requireAuth: false,
      })
      await this.#deps.beforeMigration()
      if (operation.signal.aborted) throw new VaultError('cancelled')
      // Snapshot only after all asynchronous native interactions, then inventory,
      // verify and commit synchronously while other application work is stopped.
      const settings = readVaultSource(this.#deps.userData, 'settings.json')
      const ssh = readVaultSource(this.#deps.userData, 'ssh-credentials.json')
      const migrated = migrateVaultStores(settings, ssh, this.#deps.legacy, key, manifest)
      commitVaultMigration(this.#deps.userData, migrated, manifest)
      this.#installSession(manifest)
      this.#deps.restart()
    } catch (error) {
      this.#migrationFailed = true
      throw error
    } finally {
      key?.fill(0)
      releaseMaintenance?.()
      this.#operation = null
      // If a durable transaction needs replay, no legacy use is allowed until restart.
      this.#busy = existsSync(join(this.#deps.userData, '.vault-migration'))
    }
  }
  async backup(): Promise<void> {
    if (this.#busy || !this.#manifest) throw new VaultError('unsupported')
    const manifest = this.#manifest
    this.#busy = true
    const operation = new AbortController()
    this.#operation = operation
    let key: Buffer | null = null
    try {
      const reply = await this.#deps.invoke(
        nativeRequest('backup', this.#deps.userData, manifest),
        operation.signal,
      )
      key = this.#key(reply)
      if (!reply.recoveryVerified || operation.signal.aborted) throw new VaultError('cancelled')
      this.#synchronizeEnvelope(key, reply)
      const current = this.#manifest
      const updated = authenticateManifest(key, { ...current, recovery: 'verified' })
      writeVaultFile(this.#deps.userData, 'vault-manifest.json', JSON.stringify(updated))
      this.#manifest = updated
    } finally {
      key?.fill(0)
      this.#busy = false
      this.#operation = null
    }
  }
  async setRequireAuth(requireAuth: boolean): Promise<void> {
    if (this.#busy || !this.#manifest) throw new VaultError('unsupported')
    this.#busy = true
    const operation = new AbortController()
    this.#operation = operation
    let key: Buffer | null = null
    try {
      const reply = await this.#deps.invoke(
        { ...nativeRequest('set-auth', this.#deps.userData, this.#manifest), requireAuth },
        operation.signal,
      )
      key = this.#key(reply)
      if (!reply.deviceKeyId || !reply.deviceEnvelope) throw new VaultError('corrupt')
      if (reply.requireAuth !== requireAuth || operation.signal.aborted)
        throw new VaultError('cancelled')
      this.#synchronizeEnvelope(key, reply)
    } finally {
      key?.fill(0)
      this.#busy = false
      this.#operation = null
    }
  }
  async recover(): Promise<void> {
    if (this.#busy || !this.#manifest) throw new VaultError('unsupported')
    const manifest = this.#manifest
    this.#busy = true
    this.#session?.lock()
    const operation = new AbortController()
    this.#operation = operation
    let key: Buffer | null = null
    let releaseMaintenance: (() => void) | undefined
    try {
      releaseMaintenance = acquireVaultMaintenance(this.#deps.userData)
      await this.#deps.beforeMigration()
      const reply = await this.#deps.invoke(
        nativeRequest('recover', this.#deps.userData, manifest),
        operation.signal,
      )
      key = this.#key(reply)
      verifyManifest(key, manifest)
      if (!reply.deviceKeyId || !reply.deviceEnvelope || operation.signal.aborted)
        throw new VaultError('corrupt')
      const updated = authenticateManifest(key, {
        ...manifest,
        deviceKeyId: reply.deviceKeyId,
        deviceEnvelope: reply.deviceEnvelope,
        requireAuth: reply.requireAuth ?? true,
      })
      writeVaultFile(this.#deps.userData, 'vault-manifest.json', JSON.stringify(updated))
      this.#installSession(updated)
      this.#deps.restart()
    } finally {
      key?.fill(0)
      releaseMaintenance?.()
      this.#busy = false
      this.#operation = null
    }
  }
}

/** Product identity is pinned, not accepted from the renderer or runtime environment. */
export function nativeVaultInvoker(executable: string): ProfileVaultDependencies['invoke'] {
  return (request, signal) => callNativeVault({ executable, teamId: 'VRQQV62MK3' }, request, signal)
}
