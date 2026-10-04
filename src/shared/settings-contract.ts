import type { z } from 'zod'
import type { RENDERER_WRITABLE_SETTING_SCHEMAS } from '../main/services/storage/settings-writable.ts'
import type { MAIN_ONLY_SETTING_SCHEMAS } from '../main/services/storage/settings-schema.ts'

/** Ordinary preferences only. Credentials and guarded security use dedicated APIs. */
export type SettingsUpdate = {
  -readonly [
    K in Exclude<keyof typeof RENDERER_WRITABLE_SETTING_SCHEMAS, 'trustedSshHosts'>
  ]?: z.output<(typeof RENDERER_WRITABLE_SETTING_SCHEMAS)[K]>
} & { roleAssignments?: Record<string, string> }

type ReadableSchemas = typeof RENDERER_WRITABLE_SETTING_SCHEMAS & typeof MAIN_ONLY_SETTING_SCHEMAS

/** Missing or invalid values are omitted; sections own their defaults. */
export type SettingsSnapshot = {
  [K in keyof ReadableSchemas]?: z.output<ReadableSchemas[K]>
}
