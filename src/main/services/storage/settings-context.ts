import { AsyncLocalStorage } from 'node:async_hooks'

export interface ExplicitSettingsProfile {
  /** Complete settings overlay for this run. Missing keys use call-site defaults, never disk. */
  readonly values: Readonly<Record<string, unknown>>
  /** Provider credentials for this run. Missing providers are unavailable, never read from disk/env. */
  readonly apiKeys?: Readonly<Record<string, string>>
}

const storage = new AsyncLocalStorage<ExplicitSettingsProfile>()

/** Run work against an explicit settings/key profile without reading ambient persisted settings. */
export function runWithExplicitSettings<T>(profile: ExplicitSettingsProfile, fn: () => T): T {
  return storage.run(profile, fn)
}

export function getExplicitSettingsProfile(): ExplicitSettingsProfile | null {
  return storage.getStore() ?? null
}
