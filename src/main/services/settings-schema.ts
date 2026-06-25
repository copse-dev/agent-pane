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

const extraProviderModelSchema = z.object({
  id: z.string().min(1).max(256),
  label: z.string().max(256).optional(),
  contextWindow: z.number().int().positive().optional(),
})

// Persisted override (for a built-in preset) or full definition (for a user
// custom). `slug` matches the URL-safe form derived from a base-URL hostname.
export const storedExtraProviderSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{1,64}$/),
  label: z.string().max(256).optional(),
  baseUrl: z.string().max(2048).optional(),
  keyPrefix: z.string().max(64).optional(),
  models: z.array(extraProviderModelSchema).max(256).optional(),
  fallbackContextWindow: z.number().int().positive().optional(),
  includeUsage: z.boolean().optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
})

export const extraProvidersSchema = z.array(storedExtraProviderSchema).max(64)

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
  // User's OpenAI-compatible providers: preset overrides + custom definitions.
  // Managed via dedicated IPC (settings:saveExtraProvider), not settings:set.
  extraProviders: extraProvidersSchema,
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
