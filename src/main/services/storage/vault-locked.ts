import { VaultError } from '@copse/store-kit/profile-vault-crypto.ts'

/**
 * Availability probes (tool registration, startup wiring) treat a locked
 * saved-secret vault as "no key available yet" instead of aborting. Every
 * other vault failure still propagates, and request-time readers keep calling
 * the throwing accessors so a locked vault is reported rather than hidden.
 */
export function unlessVaultLocked<T>(read: () => T, whenLocked: T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof VaultError && error.reason === 'locked') return whenLocked
    throw error
  }
}
