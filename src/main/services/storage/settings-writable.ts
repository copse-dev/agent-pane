import { z } from 'zod'
import { APP_ICON_VARIANTS } from '@shared/app-icon-variants.ts'
import {
  validateRemoteAgentBaseUrl,
  validateWebOriginPattern,
} from '../security/web-origin-policy.ts'

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

// One external ACP agent Copse can spawn and drive (client role). Mirrors
// `AcpAgentConfig` in src/shared/types/acp.ts; the model value is `acp:<id>`.
export const acpAgentConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'id must be a lowercase slug (a-z, 0-9, -)'),
  title: z.string().min(1).max(256),
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(64).optional(),
  env: z.record(z.string().max(256), z.string().max(8192)).optional(),
  model: z.string().min(1).max(512).optional(),
  availableModels: z
    .array(z.object({ value: z.string().min(1).max(512), label: z.string().min(1).max(256) }))
    .max(256)
    .optional(),
  // Seatbelt override (issue #590): object = custom confines, false = opt out,
  // absent = the KNOWN_ACP_AGENTS catalog preset for this id. homeDirs are
  // home-relative and may not escape upward.
  sandbox: z
    .union([
      z.object({
        allowedDomains: z.array(z.string().min(1).max(256)).max(64),
        homeDirs: z
          .array(
            z
              .string()
              .min(1)
              .max(1024)
              .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), {
                message: 'homeDirs entries must be home-relative without ..',
              }),
          )
          .max(32)
          .optional(),
        scratchPaths: z
          .array(
            z
              .string()
              .min(2)
              .max(1024)
              .refine((p) => p.startsWith('/') && !p.split('/').includes('..'), {
                message: 'scratchPaths entries must be absolute without ..',
              }),
          )
          .max(16)
          .optional(),
      }),
      z.literal(false),
    ])
    .optional(),
  enabled: z.boolean(),
})

export const registeredAcpAgentsSchema = z.array(acpAgentConfigSchema).max(64)

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

export const trustedShellCommandsSchema = z.array(z.string().min(1).max(128)).max(500)

export const RENDERER_WRITABLE_SETTING_SCHEMAS = {
  model: z.string().max(256),
  theme: z.enum(['light', 'dark']),
  fontSize: z.number().int().min(8).max(32),
  autoPortraitRightPanel: z.boolean(),
  rightPanelPosition: z.enum(['auto', 'side', 'bottom']),
  // Whole-app tint: a hue mixed into every neutral surface at a chosen
  // strength. Colour is a #rrggbb hex; strength maps to a mix percentage in
  // the renderer (off = no tint). See tokens.css --tint-hue / --tint-amount.
  uiTintColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  uiTintStrength: z.enum(['off', 'subtle', 'medium', 'strong']),
  appIconVariant: z.enum(APP_ICON_VARIANTS),
  layout: z.object({
    projectsPaneWidth: z.number().int().min(180).max(400),
    filesPaneWidth: z.number().int().min(300).max(4000),
    fileTreeWidth: z.number().int().min(120).max(400),
  }),
  localDefaultModel: z.string().max(256),
  smallTasksModel: z.string().max(256),
  subagentModel: z.string().max(256),
  // Role → model assignments (the indirection layer, see agent-roles.ts). A role
  // entry overrides the legacy per-feature setting for the renderer-writable
  // routing roles (coder / small-tasks / research); main-only security roles
  // (safety, review) are NOT routed here so they stay on the guarded security IPC.
  roleModels: z.record(z.string().max(64), z.string().max(256)),
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
  // Which backend the PR panel + PR tools use to reach GitHub: `auto` prefers
  // the `gh` CLI and falls back to the REST/GraphQL API, or force one. See
  // services/github/backend/backend.ts.
  githubBackend: z.enum(['auto', 'cli', 'api']),
  remoteAgentBaseUrl: remoteAgentBaseUrlSchema,
  remoteAgentAutoCreatePR: z.boolean(),
  remoteAgentWorkOnCurrentBranch: z.boolean(),
  // External ACP agents Copse drives as a client (model value `acp:<id>`).
  registeredAcpAgents: registeredAcpAgentsSchema,
  browserToolsEnabled: z.boolean(),
  browserAllowedOrigins: z.array(z.string().max(2048)).max(256),
  // Auto-approve an external ACP agent's file edits/deletes/moves once a durable
  // worktree backup of the user's uncommitted work exists, instead of prompting
  // per edit. Default on. Off restores the per-edit approval modal.
  acpAutoApproveEditsWithBackup: z.boolean(),
  // Auto-approve an external ACP agent's calls to Copse's *own* bridged native
  // tools (gh_*/CI, semantic search, staged diffs, browser, web fetch). These
  // re-enter Copse's native permission gate when the bridge executes them, so
  // the ACP prompt only duplicates that gate. Default on. Off restores the
  // per-call prompt for bridged tools.
  acpAutoApproveNativeBridgeTools: z.boolean(),
  // Experimental features, opt-in and off by default. See the experimental
  // section in Settings.
  mcpUiArtefactsEnabled: z.boolean(),
  ciInvestigatorEnabled: z.boolean(),
  okfMemoriesEnabled: z.boolean(),
  longHorizonTasksEnabled: z.boolean(),
  modelClassifierEnabled: z.boolean(),
  advisorStrategyEnabled: z.boolean(),
  advisorModel: z.string().max(256),
  // Experimental model comparison harness: run the working-diff review through
  // two models plus a judge that compares their verdicts. See model-comparison.ts.
  modelComparisonEnabled: z.boolean(),
  modelComparisonAutoOnReview: z.boolean(),
  comparisonModelA: z.string().max(256),
  comparisonModelB: z.string().max(256),
  comparisonJudgeModel: z.string().max(256),
  roadmapPlansEnabled: z.boolean(),
  backgroundTasksEnabled: z.boolean(),
  piiRedactionEnabled: z.boolean(),
  devtoolsShortcutEnabled: z.boolean(),
  customInstructions: z.string().max(8192),
  onboardingCompleted: z.boolean(),
  // Opt-in consent for scanning the shell environment / start-up files for
  // provider API keys (default off; see env-key-detection.ts).
  envKeyAutoDetectEnabled: z.boolean(),
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
  // Split thresholds sent by the Settings dialog. The legacy single value is kept
  // optional for back-compat with older stored bundles but is no longer written.
  safetySandboxAllowThreshold: z.number().min(0).max(1),
  safetyExternalDenyThreshold: z.number().min(0).max(1),
  safetyConfidenceThreshold: z.number().min(0).max(1).optional(),
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
  // Allow-list of command basenames trusted to run unsandboxed with no prompt.
  // Optional so bundles that never send it don't clobber a saved list.
  trustedShellCommands: trustedShellCommandsSchema.optional(),
})

export type SecuritySettings = z.infer<typeof securitySettingsSchema>
