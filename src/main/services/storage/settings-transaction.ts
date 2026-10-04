import { z } from 'zod'
import type { SettingsSnapshot, SettingsUpdate } from '@shared/settings-contract.ts'
import { RENDERER_WRITABLE_SETTING_SCHEMAS, isSecretSettingKey } from './settings-writable.ts'
import { MAIN_ONLY_SETTING_SCHEMAS, registeredSettingKeys } from './settings-schema.ts'
import { getRegisteredSetting, setSettings } from './settings.ts'

export const settingsUpdateSchema = z
  .strictObject(RENDERER_WRITABLE_SETTING_SCHEMAS)
  .omit({ trustedSshHosts: true })
  .extend({
    roleAssignments: RENDERER_WRITABLE_SETTING_SCHEMAS.roleModels,
  })
  .partial()
  .refine(
    (values) => values.roleModels === undefined || values.roleAssignments === undefined,
    'Use either a complete role map or an assignment patch',
  )

export function getSettingsSnapshot(): SettingsSnapshot {
  // The schema registry is the readable allowlist; never enumerate the store,
  // which contains encrypted credentials and other private host state.
  const values: Record<string, unknown> = {}
  for (const key of registeredSettingKeys()) {
    if (isSecretSettingKey(key)) continue
    const value = getRegisteredSetting(key)
    if (value !== undefined) values[key] = value
  }
  return settingsSnapshotSchema.parse(values)
}

const settingsSnapshotSchema = z
  .strictObject({ ...RENDERER_WRITABLE_SETTING_SCHEMAS, ...MAIN_ONLY_SETTING_SCHEMAS })
  .partial()

export async function updateSettings(raw: unknown): Promise<SettingsUpdate> {
  const changes = settingsUpdateSchema.parse(raw)
  const { roleAssignments, ...values } = changes
  await setSettings(values, roleAssignments)
  return changes
}
