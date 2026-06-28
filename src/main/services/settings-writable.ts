import { z } from 'zod'
import { APP_ICON_VARIANTS } from '@shared/app-icon-variants.ts'
import { validateRemoteAgentBaseUrl, validateWebOriginPattern } from './web-origin-policy.ts'

// Empty string means "use the provider default"; any non-empty value must be a
// safe base URL since it carries the Cursor API key as an Authorization header.
export const remoteAgentBaseUrlSchema = z
  .string()
  .max(2048)
  .superRefine((value, ctx) => {
    if (value.trim() === '') return
    try {
      validateRemoteAgentBaseUrl(value)
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Invalid remote agent base URL',
      })
    }
  })

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
  openRouterModel: z.string().max(256),
  localSubagentsEnabled: z.boolean(),
  localTodoItemsEnabled: z.boolean(),
  postTurnReviewEnabled: z.boolean(),
  bundledCursorSkillsEnabled: z.boolean(),
  skillsEnabled: z.boolean(),
  // Skill safety toggles (default on). Warn up front when an invoked skill
  // references external links; reinforce sandbox/approval confinement for skills.
  skillExternalLinkWarnings: z.boolean(),
  skillSandboxGuidance: z.boolean(),
  skillPluginPaths: z.array(z.string().max(4096)).max(64),
  subagentsEnabled: z.boolean(),
  externalApiSafety: z.boolean(),
  remoteAgentBaseUrl: remoteAgentBaseUrlSchema,
  remoteAgentRepository: z.string().max(2048),
  remoteAgentStartingRef: z.string().max(256),
  remoteAgentAutoCreatePR: z.boolean(),
  remoteAgentWorkOnCurrentBranch: z.boolean(),
  browserToolsEnabled: z.boolean(),
  browserAllowedOrigins: z.array(z.string().max(2048)).max(256),
  // Experimental features, opt-in and off by default. See the experimental
  // section in Settings.
  mcpUiArtefactsEnabled: z.boolean(),
  customInstructions: z.string().max(8192),
  onboardingCompleted: z.boolean(),
} as const satisfies Record<string, z.ZodType>

export type RendererWritableSettingKey = keyof typeof RENDERER_WRITABLE_SETTING_SCHEMAS

export function isRendererWritableSettingKey(key: string): key is RendererWritableSettingKey {
  return key in RENDERER_WRITABLE_SETTING_SCHEMAS
}

/**
 * Setting keys holding secret material that must never be read back through the
 * renderer-facing `settings:get` IPC. API keys are persisted under `apiKey.<provider>`
 * in the same store as ordinary settings; without this guard a renderer (or any
 * compromised frame) could read the stored key record — which is base64 plaintext
 * when the OS keyring is unavailable. The renderer only ever needs the boolean
 * `settings:getKey` (hasApiKey), never the record itself.
 */
export function isSecretSettingKey(key: string): boolean {
  return key === 'apiKey' || key.startsWith('apiKey.')
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
  // Optional: distinct model for the post-turn review subagent. Empty/absent
  // means reuse the parent chat model.
  reviewModel: z.string().max(256).optional(),
  autoRunSandboxCommands: z.boolean(),
  mcpAutoAllowReadOnly: z.boolean(),
  // Storage-only setting with no Settings UI yet (see docs/cursor-hooks.md). Optional so the
  // renderer's setSecurity bundle, which never sends it, doesn't fail validation or clobber it.
  cursorHooksEnabled: z.boolean().optional(),
  defaultReadonlyMode: z.boolean(),
  webAllowedOrigins: webAllowedOriginsSchema,
  webAllowUserApproval: z.boolean(),
})

export type SecuritySettings = z.infer<typeof securitySettingsSchema>
