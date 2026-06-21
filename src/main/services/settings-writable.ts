import { z } from 'zod'

export const RENDERER_WRITABLE_SETTING_SCHEMAS = {
  model: z.string().max(256),
  theme: z.enum(['light', 'dark']),
  fontSize: z.number().int().min(8).max(32),
  layout: z.object({
    projectsPaneWidth: z.number().int().min(180).max(400),
    filesPaneWidth: z.number().int().min(300).max(4000),
    fileTreeWidth: z.number().int().min(120).max(400),
  }),
  lmStudioModel: z.string().max(256),
  lmStudioSmallTasksModel: z.string().max(256),
  lmStudioSubagentModel: z.string().max(256),
  lmStudioForSmallTasks: z.boolean(),
  lmStudioForSubagents: z.boolean(),
  skillsEnabled: z.boolean(),
  skillPluginPaths: z.array(z.string().max(4096)).max(64),
  subagentsEnabled: z.boolean(),
} as const satisfies Record<string, z.ZodType>

export type RendererWritableSettingKey = keyof typeof RENDERER_WRITABLE_SETTING_SCHEMAS

export function isRendererWritableSettingKey(key: string): key is RendererWritableSettingKey {
  return key in RENDERER_WRITABLE_SETTING_SCHEMAS
}

export function parseRendererWritableSetting(
  key: RendererWritableSettingKey,
  value: unknown,
): unknown {
  return RENDERER_WRITABLE_SETTING_SCHEMAS[key].parse(value)
}

export const securitySettingsSchema = z.object({
  lmStudioUrl: z.string().max(2048),
  lmStudioSafetyEnabled: z.boolean(),
  lmStudioSafetyConfidenceThreshold: z.number().min(0).max(1),
  lmStudioSafetyModel: z.string().max(256),
  autoRunSandboxCommands: z.boolean(),
  mcpAutoAllowReadOnly: z.boolean(),
})

export type SecuritySettings = z.infer<typeof securitySettingsSchema>
