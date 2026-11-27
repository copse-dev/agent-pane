import { createKeyringCipher } from '@copse/store-kit/keyring-cipher.ts'
import { createOsKeyringStore } from '@copse/store-kit/os-keyring.ts'
import { setSecretCipher } from '@copse/store-kit/secret-cipher.ts'
import { setElectronAppRuntime } from '../electron-app-runtime.ts'
import { setPersistentStoreFactory } from '../storage/persistent-store.ts'
import { readOnlyProfileStoreFactory, readProfileStores } from './read-only-profile-store.ts'
/**
 * Boot a process the app started outside itself (a turn worker, a container
 * run host) on the profile, read-only: the profile's paths, its stores read
 * once and never written back, and API keys opened through the keyring cipher
 * (decision 5). Call before importing any module that opens a store.
 */
export async function installReadOnlyProfile(options: {
  userDataPath: string
  version: string
  packaged: boolean
  log: (line: string) => void
}): Promise<void> {
  setElectronAppRuntime({
    userDataPath: options.userDataPath,
    version: options.version,
    isPackaged: options.packaged,
  })
  setPersistentStoreFactory(
    readOnlyProfileStoreFactory(await readProfileStores(options.userDataPath), (store, key) => {
      options.log(`kept a write to ${store}.json "${key}" in memory only`)
    }),
  )
  setSecretCipher(createKeyringCipher(createOsKeyringStore()))
}
