import { z } from 'zod'
import { APP_ICON_VARIANTS } from '@shared/app-icon-variants.ts'
import { validateWebOriginPattern } from './web-origin-policy.ts'

export const webAllowedOriginsSchema = z
  .array(
    z
      .string()
      .max(256)
      .transform((value, ctx) => {
        try {
          return validateWebOriginPattern(value)
        } catch (error) {
          ctx.addIssue({
            code: 'custom',
            message: error instanceof Error ? error.message : 'Invalid web origin',
          })
          return z.NEVER
        }
      }),
  )
  .max(128)

export const RENDERER_WRITABLE_SETTING_SCHEMAS = {
  model: z.string().max(256),
  theme: z.enum(['light', 'dark']),
  fontSize: z.number().int().min(8).max(32),
  autoPortraitRightPanel: z.boolean(),
  appIconVariant: z.enum(APP_ICON_VARIANTS),
  layout: z.object({
    projectsPaneWidth: z.number().int().min(180).max(400),
    filesPaneWidth: z.number().int().min(300).max(4000),
    fileTreeWidth: z.number().int().min(120).max(400),
  }),
  localDefaultModel: z.string().max(256),
  smallTasksModel: z.string().max(256),
  subagentModel: z.string().max(256),
  localSubagentsEnabled: z.boolean(),
  localTodoItemsEnabled: z.boolean(),
  skillsEnabled: z.boolean(),
  skillPluginPaths: z.array(z.string().max(4096)).max(64),
  subagentsEnabled: z.boolean(),
  externalApiSafety: z.boolean(),
  remoteAgentBaseUrl: z.string().max(2048),
  remoteAgentRepository: z.string().max(2048),
  remoteAgentStartingRef: z.string().max(256),
  remoteAgentAutoCreatePR: z.boolean(),
  remoteAgentWorkOnCurrentBranch: z.boolean(),
  browserToolsEnabled: z.boolean(),
  browserAllowedOrigins: z.array(z.string().max(2048)).max(256),
  customInstructions: z.string().max(8192),
  onboardingCompleted: z.boolean(),
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
  localServerUrl: z.string().max(2048),
  safetyClassifierEnabled: z.boolean(),
  safetyConfidenceThreshold: z.number().min(0).max(1),
  safetyModel: z.string().max(256),
  autoRunSandboxCommands: z.boolean(),
  mcpAutoAllowReadOnly: z.boolean(),
  cursorHooksEnabled: z.boolean(),
  webAllowedOrigins: webAllowedOriginsSchema,
  webAllowUserApproval: z.boolean(),
})

export type SecuritySettings = z.infer<typeof securitySettingsSchema>
