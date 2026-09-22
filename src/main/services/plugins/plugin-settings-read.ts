// Direct reads of a plugin's persisted settings bag, kept apart from the plugin
// service so a host read site — `advisor-runner.ts`, `review-service.ts`,
// `project-instructions.ts` — can read a plugin-owned value without importing
// the service's boot-time dependencies (plugin tool hosts, the sandbox spawn
// path and its native modules). Storage only; no init-order coupling.
import { storageGet } from '../storage/storage.ts'
import { isRecord } from '@shared/unknown-value.ts'

/** Storage key holding one plugin's settings values (`pluginId` scoped). */
export function pluginSettingsKey(pluginId: string): string {
  return `plugin.${pluginId}.settings`
}

/** Read one plugin's persisted settings bag (`{}` when nothing stored). */
export function readPluginSettings(pluginId: string): Record<string, unknown> {
  const raw = storageGet(pluginSettingsKey(pluginId))
  return isRecord(raw) ? raw : {}
}

/**
 * Read one plugin-scoped setting value directly from storage, without
 * constructing (or booting) the plugin service. Returns the raw persisted
 * value (the caller coerces/trims); `undefined` when unset.
 */
export function readPluginSettingValue(pluginId: string, key: string): unknown {
  return readPluginSettings(pluginId)[key]
}
