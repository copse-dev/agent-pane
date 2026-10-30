import { openPersistentStore } from './persistent-store.ts'
import { deleteSetting } from './settings.ts'

/**
 * Put a value in the settings backing store without validation, as a hand edit
 * of settings.json would. `setSetting` rejects a value that fails its schema, so
 * a test of the read-side guard seeds the bad value here instead. Deleting the
 * key first drops it from the settings cache, so the next read reaches the
 * backing store; the headless backend shares one store per name.
 */
export async function seedHandEditedSetting(key: string, value: unknown): Promise<void> {
  await deleteSetting(key)
  openPersistentStore({ name: 'settings' }).set(key, value)
}
