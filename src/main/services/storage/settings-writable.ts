import { z } from 'zod'
import { APP_ICON_VARIANTS } from '@shared/app-icon-variants.ts'
import { AUTO_APPROVAL_LEVELS } from '@shared/auto-approval.ts'
import { REASONING_LEVELS } from '@copse/llm/model-parameters.ts'
import { SERVICE_TIERS } from '@copse/llm/service-tier.ts'
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
    .array(
      z.object({
        value: z.string().min(1).max(512),
        label: z.string().min(1).max(256),
        // Agents that label models by family alone put the version here.
        description: z.string().max(1024).optional(),
      }),
    )
    .max(256)
    .optional(),
  // Epoch-ms timestamp of the probe that produced `availableModels`, used by the
  // background staleness check to re-probe aged caches (see acp-auto-setup.ts).
  modelsProbedAt: z.number().int().nonnegative().optional(),
  // ACP session (permission) mode to start each session in, and the cached set
  // of modes the agent advertised the last time it was probed (issue #607).
  permissionMode: z.string().min(1).max(256).optional(),
  availablePermissionModes: z
    .array(
      z.object({
        value: z.string().min(1).max(256),
        label: z.string().min(1).max(256),
        description: z.string().max(1024).optional(),
      }),
    )
    .max(64)
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

/**
 * Generation parameters the user tuned for one model selection. Mirrors
 * `ModelParameters` in `@copse/llm/model-parameters.ts`; the bounds here are
 * the loosest any family accepts (Anthropic caps temperature at 1, but the
 * read side clamps per model, so a value saved against one model and later
 * read for a stricter one degrades rather than 400s).
 */
export const modelParametersSchema = z.object({
  reasoning: z.enum(REASONING_LEVELS).optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().min(0).max(500).optional(),
  minP: z.number().min(0).max(1).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  repetitionPenalty: z.number().min(0).max(2).optional(),
})

/** Model selection → its tuned parameters. Keys are picker values, not bare ids. */
export const modelParametersMapSchema = z.record(z.string().max(512), modelParametersSchema)

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

/** Highest auto-approval tier honoured for shell commands (see @shared/auto-approval.ts). */
export const autoApprovalLevelSchema = z.enum(AUTO_APPROVAL_LEVELS)

export const RENDERER_WRITABLE_SETTING_SCHEMAS = {
  model: z.string().max(256),
  theme: z.enum(['system', 'light', 'dark']),
  fontSize: z.number().int().min(8).max(32),
  // Whole-UI multiplier for design tokens (--ui-scale). Independent of
  // fontSize (editor/terminal); see src/shared/ui-scale.ts.
  uiScale: z.number().min(0.75).max(1.5),
  autoPortraitRightPanel: z.boolean(),
  rightPanelPosition: z.enum(['auto', 'side', 'bottom']),
  // Interaction colour for links, primary actions, selections, and chat
  // emphasis. Theme CSS derives accessible link/hover shades from this hue.
  uiAccentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
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
  // routing roles (coder / small-tasks / research / advisor); main-only security
  // roles (safety, review) are NOT routed here so they stay on the guarded
  // security IPC.
  roleModels: z.record(z.string().max(64), z.string().max(256)),
  // Per-model generation parameters (reasoning depth and the sampling knobs),
  // keyed by the model selection they were tuned for so they travel with the
  // model rather than with a feature. Sanitized per model on read — see
  // `resolveModelParameters` — so an entry saved against one model cannot be
  // sent to another that rejects it.
  modelParameters: modelParametersMapSchema,
  openRouterModel: z.string().max(256),
  // OpenAI `service_tier` for first-party gpt-* models: 'flex' for slower and
  // cheaper, 'priority' for quicker at a higher price. Empty (the default) omits
  // the field, leaving OpenAI on standard processing.
  //
  // Pinned to the documented tiers. `SERVICE_TIERS` matches OpenAI's set exactly
  // — including that Priority is marketed as "Fast mode" but is never sent as
  // `fast`. Accepting arbitrary strings here would let a plausible-looking value
  // through to a guaranteed 400 at request time, which is a worse failure than
  // refusing the write.
  //
  // NOTE: the usage ledger prices turns from the standard-tier catalog, so a
  // non-default tier makes those figures wrong (flex overstates, priority
  // understates) — see #1543. Tier-aware pricing is a follow-up; LiteLLM already
  // publishes `input_cost_per_token_flex` / `_priority` for these models.
  openAiServiceTier: z.enum(['', ...SERVICE_TIERS]),
  // Restrict OpenRouter routing to zero-data-retention endpoints
  // (provider.zdr). Default ON; the read side (provider-selection.ts) treats
  // a missing value as true.
  openRouterZdrOnly: z.boolean(),
  // Allow OpenRouter to route to providers that may store or train on inputs
  // (drops data_collection:"deny"). Default OFF; independent of the ZDR
  // toggle so relaxing retention never silently re-admits trainers.
  openRouterAllowTraining: z.boolean(),
  // When true, the OpenRouter picker shows only free, tool-capable models.
  // When false (default), it shows every tool-capable text model regardless of
  // price — letting the user pick a paid model from the live catalog.
  openRouterFreeMode: z.boolean(),
  localSubagentsEnabled: z.boolean(),
  localTodoItemsEnabled: z.boolean(),
  // P5: the former top-level `postTurnReviewEnabled` boolean is retired —
  // the `copse.post-turn-review` first-party pack toggle in Settings > Packs
  // is the atomic master switch consulted by the trigger site in
  // `agent-service.ts`. The threshold below stays a top-level setting.
  //
  // Skip the post-turn review when the working diff has fewer changed lines than
  // this threshold (#584). Default 1 skips only an empty diff (nothing to review);
  // a larger value also skips trivial edits; 0 always reviews. Separately, billable
  // review models are gated by a per-chat spend approval (see agent-service.ts).
  postTurnReviewMinChangedLines: z.number().int().min(0).max(100_000),
  /**
   * User-entered Claude subscription monthly fee (USD) for the plan worth-it
   * verdict. Null/absent means unset — the UI may still hint a fee from weekly
   * `limitDollars` tiers.
   */
  claudePlanMonthlyFeeUsd: z.number().min(1).max(10_000).nullable(),
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
  // When true (default) and a Claude Cloud Agent turn cannot run — the stored
  // Anthropic key is missing/rejected, or the API account is out of credit —
  // offer to re-run it on an enabled ACP Claude agent, which authenticates
  // against the user's own `claude` login and bills against plan headroom.
  // The offer always asks: the managed Agents API has no subscription billing
  // mode, and the two paths differ (remote sandbox + PR vs. local worktree),
  // so a working Cloud Agent selection is never redirected behind the user's
  // back. Off means the turn falls back to a local chat model instead.
  preferAcpOverCloudAgent: z.boolean(),
  // External ACP agents Copse drives as a client (model value `acp:<id>`).
  registeredAcpAgents: registeredAcpAgentsSchema,
  browserToolsEnabled: z.boolean(),
  browserAllowedOrigins: z.array(z.string().max(2048)).max(256),
  // When on (default), http(s) links clicked in chat/PR/preview surfaces open in
  // the in-app browser pane. When off, they open in the user's default browser
  // and render an external-link icon so it's clear they leave the app.
  openLinksInBuiltInBrowser: z.boolean(),
  // Event triggers and delivery channels are independent: users can keep a
  // silent system notification without a Dock/taskbar animation, for example.
  alertOnInteraction: z.boolean(),
  alertOnThreadFinished: z.boolean(),
  alertSystemNotification: z.boolean(),
  alertSound: z.boolean(),
  alertBounce: z.boolean(),
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
  //
  // The MCP-UI artefacts (canvas) gate moved to the `copse.mcp-ui-canvas`
  // first-party pack's `mcp-ui-canvas` capability (Settings > Packs), so the
  // former `mcpUiArtefactsEnabled` top-level boolean is retired.
  modelClassifierEnabled: z.boolean(),
  advisorModel: z.string().max(256),
  // Experimental orchestration strategy: the chat model orchestrates and a
  // cheaper worker model implements delegated steps. See orchestration-strategy.ts.
  orchestrationStrategyEnabled: z.boolean(),
  orchestrationWorkerModel: z.string().max(256),
  // Experimental model comparison harness: run the working-diff review through
  // two models plus a judge that compares their verdicts. See model-comparison.ts.
  // P5: the former top-level `modelComparisonEnabled` boolean is retired —
  // the `copse.model-comparison` first-party pack toggle in Settings > Packs
  // is the atomic master switch. The sub-toggle below is still top-level.
  modelComparisonAutoOnReview: z.boolean(),
  comparisonModelA: z.string().max(256),
  comparisonModelB: z.string().max(256),
  comparisonJudgeModel: z.string().max(256),
  // Background tasks moved to the `copse.background-tasks` first-party pack
  // (Settings > Packs), which also DECLARES the `loopback-bind` sandbox
  // relaxation (issue #1190), so the former `backgroundTasksEnabled` top-level
  // boolean is retired — the pack toggle is the master switch.
  /** When false, hide read_terminal and @shell (on by default). */
  readTerminalEnabled: z.boolean(),
  developerMode: z.boolean(),
  // The DevTools shortcut moved to the `copse.devtools-shortcut` first-party
  // pack's `devtools-shortcut` capability (Settings > Packs), so the former
  // `devtoolsShortcutEnabled` top-level boolean is retired.
  customInstructions: z.string().max(8192),
  onboardingCompleted: z.boolean(),
  // Opt-in consent for scanning the shell environment / start-up files for
  // provider API keys (default off; see env-key-detection.ts).
  envKeyAutoDetectEnabled: z.boolean(),
  // SSH host-key policy for git-over-SSH in runners and the shell tool. See
  // docs/plans/ssh-remote-repo.md Phase 0.
  sshStrictHostKeys: z.enum(['accept-new', 'strict']),
  // Experimental: route shell/terminal/background spawns through the SSH workspace
  // connection when the active project has an `sshHost`. See ssh-remote-repo.md.
  sshWorkspaceEnabled: z.boolean(),
  // Experimental: when the active project is an SSH workspace, spawn external ACP
  // agents on the remote host (stdio over the SSH connection) instead of blocking
  // ACP. Only meaningful when `sshWorkspaceEnabled` is also on. See
  // docs/plans/acp-over-ssh.md.
  acpOverSshEnabled: z.boolean(),
  // SSH workspace hosts (Phase 1 connection manager). See ssh-remote-repo.md.
  sshWorkspaceHosts: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        label: z.string().min(1).max(256),
        host: z.string().min(1).max(256),
        port: z.number().int().min(1).max(65535).optional(),
        user: z.string().max(256).optional(),
        identityFile: z.string().max(4096).optional(),
        forwardAgent: z.boolean().optional(),
      }),
    )
    .max(64),
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
  safetyExternalDenyThreshold: z.number().min(0).max(1),
  safetyModel: z.string().max(256),
  // Optional: distinct model for the post-turn review subagent. Empty/absent
  // means reuse the parent chat model.
  reviewModel: z.string().max(256).optional(),
  autoRunSandboxCommands: z.boolean(),
  mcpAutoAllowReadOnly: z.boolean(),
  // Toggled from Settings → Sources → Hooks (see docs/cursor-hooks.md). Optional so
  // older renderer bundles that don't send it don't fail validation or clobber it.
  cursorHooksEnabled: z.boolean().optional(),
  defaultReadonlyMode: z.boolean(),
  webAllowedOrigins: webAllowedOriginsSchema,
  webAllowUserApproval: z.boolean(),
  // Custom LLM provider host allowlist (issue #438). Optional so older renderer
  // bundles that never send them don't clobber a saved list / toggle.
  approvedProviderHosts: z.array(z.string().max(256)).max(256).optional(),
  providerAllowUserApproval: z.boolean().optional(),
  // Allow-list of command basenames trusted to run unsandboxed with no prompt.
  // Optional so bundles that never send it don't clobber a saved list.
  trustedShellCommands: trustedShellCommandsSchema.optional(),
  // Highest auto-approval tier for recognised low-risk shell shapes. Optional so
  // older renderer bundles that never send it don't reset the user's choice.
  shellAutoApprovalLevel: autoApprovalLevelSchema.optional(),
})

export type SecuritySettings = z.infer<typeof securitySettingsSchema>
