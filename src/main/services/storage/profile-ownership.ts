import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  acquireVaultMaintenance,
  registerVaultProfileClient,
  retireVaultMaintenance,
} from '@copse/store-kit/profile-vault-access.ts'
import { VaultError } from '@copse/store-kit/profile-vault-crypto.ts'
import {
  assertVaultProfileState,
  readVaultManifest,
  recoverVaultMigration,
} from '@copse/store-kit/profile-vault-files.ts'

/** Thrown when a headless client is pointed at a device-encrypted profile. */
export class HeadlessVaultProfileError extends Error {
  constructor() {
    super(
      'Device-encrypted profiles require the Copse desktop unlock service. Use a separate profile (COPSE_DIR) for headless work.',
    )
    this.name = 'HeadlessVaultProfileError'
  }
}

/**
 * Headless clients (ACP, release smoke, agent and classifier evals) share the
 * profile with a running desktop. They register a lease the desktop's
 * maintenance gate checks, and refuse profiles that need the unlock service.
 * Returns the lease release; call it on exit.
 */
export function joinSharedProfile(userData: string): () => void {
  const release = registerVaultProfileClient(userData)
  try {
    if (existsSync(join(userData, '.vault-migration')) || readVaultManifest(userData))
      throw new HeadlessVaultProfileError()
    assertVaultProfileState(userData)
    return release
  } catch (error) {
    release()
    throw error
  }
}

/**
 * Desktop owner setup. Call only while holding Electron's single-instance lock,
 * before any store is constructed: retire a crashed owner's gate, replay an
 * interrupted migration commit, then refuse inconsistent vault state.
 */
export function prepareOwnedProfile(userData: string): void {
  retireVaultMaintenance(userData)
  if (existsSync(join(userData, '.vault-migration'))) {
    const releaseMaintenance = acquireVaultMaintenance(userData)
    try {
      recoverVaultMigration(userData)
    } finally {
      releaseMaintenance()
    }
  }
  assertVaultProfileState(userData)
}

/** User-facing explanation for a profile that cannot be opened safely. */
export function profileStartupGuidance(error: unknown, userData: string): string {
  if (error instanceof HeadlessVaultProfileError) return error.message
  if (error instanceof VaultError && error.reason === 'locked')
    return 'The Copse desktop app is changing saved-secret encryption for this profile. Try again once it has finished.'
  if (error instanceof VaultError && error.reason === 'corrupt')
    return [
      `Copse stopped before opening ${userData} because its saved-secret encryption files do not match`,
      '(settings.json, vault-manifest.json and the credential stores must come from the same backup,',
      'and must be regular files rather than symlinks or hard links).',
      'Nothing was changed. Restore the complete profile from one consistent backup,',
      'or start Copse with a different profile (COPSE_DIR). See “Device-encrypted saved secrets” in docs/recovery.md.',
    ].join(' ')
  const detail = error instanceof Error ? error.message : String(error)
  return `Copse could not prepare the profile at ${userData}: ${detail}. Nothing was changed; check that the folder is present and writable.`
}
