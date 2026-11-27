import { createKeyringCipher } from '@copse/store-kit/keyring-cipher.ts'
import { createOsKeyringStore } from '@copse/store-kit/os-keyring.ts'
import { setSecretCipher } from '@copse/store-kit/secret-cipher.ts'
import { setElectronAppRuntime } from '../electron-app-runtime.ts'
import { setPersistentStoreFactory } from '../storage/persistent-store.ts'
import { forgetCachedStoreValues } from '@copse/store-kit/persistent-store.ts'
import {
  readOnlyProfileStoreFactory,
  readProfileStores,
  type ProfileStoreChange,
} from './read-only-profile-store.ts'
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
  /** Each change a write would have made; the turn host sends them to the app. */
  onChange?: (store: string, changes: ProfileStoreChange[]) => void
}): Promise<{ reload: () => Promise<void> }> {
  setElectronAppRuntime({
    userDataPath: options.userDataPath,
    version: options.version,
    isPackaged: options.packaged,
  })
  const factory = readOnlyProfileStoreFactory(
    await readProfileStores(options.userDataPath),
    (store, key) => {
      options.log(`kept a write to ${store}.json "${key}" in memory only`)
    },
    options.onChange,
  )
  setPersistentStoreFactory(factory)
  setSecretCipher(createKeyringCipher(createOsKeyringStore()))
  return {
    // The app changed the profile: read it again, under every store already open.
    reload: async (): Promise<void> => {
      factory.reload(await readProfileStores(options.userDataPath))
      forgetCachedStoreValues()
    },
  }
}
