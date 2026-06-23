import { z } from 'zod'
import { RENDERER_WRITABLE_SETTING_SCHEMAS, webAllowedOriginsSchema } from './settings-writable.ts'

// Schema registry for keys persisted in the `settings` electron-store. Reads
// validate against the matching schema (corrupt values fall back to the default)
// and writes validate before persisting. Keys without an entry keep the legacy
// untyped behaviour, so adding a schema here is incremental and non-breaking.

const windowBoundsSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive(),
  height: z.number().positive(),
})

const MAIN_ONLY_SETTING_SCHEMAS = {
  windowBounds: windowBoundsSchema,
  // Security / safety toggles read in the main process.
  localServerUrl: z.string().max(2048),
  safetyClassifierEnabled: z.boolean(),
  safetyConfidenceThreshold: z.number().min(0).max(1),
  safetyModel: z.string().max(256),
  autoRunSandboxCommands: z.boolean(),
  mcpAutoAllowReadOnly: z.boolean(),
  safeInstallEnabled: z.boolean(),
  mockFollowUps: z.boolean(),
  webAllowedOrigins: webAllowedOriginsSchema,
  webAllowUserApproval: z.boolean(),
  browserAllowUserApproval: z.boolean(),
} as const satisfies Record<string, z.ZodType>

const SETTING_SCHEMAS: Record<string, z.ZodType> = {
  ...RENDERER_WRITABLE_SETTING_SCHEMAS,
  ...MAIN_ONLY_SETTING_SCHEMAS,
}

/** The validation schema for a settings key, or `undefined` if none is registered. */
export function getSettingSchema(key: string): z.ZodType | undefined {
  return Object.prototype.hasOwnProperty.call(SETTING_SCHEMAS, key)
    ? SETTING_SCHEMAS[key]
    : undefined
}
