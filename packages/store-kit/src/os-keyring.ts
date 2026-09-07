/**
 * The OS keyring as a {@link DataKeyStore}: one generic-password item holding
 * the app's secret data key. Backed by `@napi-rs/keyring` (the Rust `keyring`
 * crate: macOS Keychain, Windows Credential Manager, Linux Secret Service), so
 * it runs anywhere Node runs — Electron's main process today, a plain-Node
 * sidecar tomorrow — with no Chromium in the path.
 *
 * The item name is deliberately stable and independent of the shell: the
 * whole point is that a different Copse binary signed by the same team opens
 * the same item and reads the same secrets. Tests and headless callers never
 * load this module; they hand `createKeyringCipher` an in-memory store.
 */
import { Entry } from '@napi-rs/keyring'
import type { DataKeyStore } from './keyring-cipher.ts'

export const KEYRING_SERVICE = 'Copse'
export const KEYRING_ACCOUNT = 'secret-data-key'

export function createOsKeyringStore(
  service = KEYRING_SERVICE,
  account = KEYRING_ACCOUNT,
): DataKeyStore {
  const entry = new Entry(service, account)
  return {
    read: (): string | null => entry.getPassword(),
    write: (value: string): void => {
      entry.setPassword(value)
    },
  }
}
