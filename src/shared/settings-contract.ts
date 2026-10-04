import type { ClassifierProfile } from '@copse/llm/classifiers/types.ts'

/** Validated, nonsecret persisted preferences. Host schemas verify this wire contract. */
export interface SettingsValues {
  acknowledgedProductAnnouncements: Array<string>
  model: string
  chatGptPlanWelcomeSeen: boolean
  theme: 'system' | 'light' | 'dark'
  fontSize: number
  uiScale: number
  animateAgentAvatars: boolean
  autoPortraitRightPanel: boolean
  rightPanelPosition: 'auto' | 'side' | 'bottom'
  uiAccentColor: string
  uiTintColor: string
  uiTintStrength: 'off' | 'subtle' | 'medium' | 'strong'
  appearanceDefaultsMigrationVersion: 1
  appIconVariant:
    | 'rose'
    | 'pink-lady'
    | 'mint-leaf'
    | 'cucumber'
    | 'aurora'
    | 'citrus'
    | 'candy'
    | 'steel'
    | 'amber'
    | 'forest'
    | 'orchid'
    | 'sunset'
    | 'ocean'
    | 'emerald'
    | 'nebula'
    | 'ember'
    | 'paper'
    | 'coral'
    | 'lagoon'
  layout: { projectsPaneWidth: number; filesPaneWidth: number; fileTreeWidth: number }
  localDefaultModel: string
  smallTasksModel: string
  subagentModel: string
  roleModels: Record<string, string>
  modelParameters: Record<
    string,
    {
      reasoning?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined
      verbosity?: 'low' | 'medium' | 'high' | undefined
      maxOutputTokens?: number | undefined
      temperature?: number | undefined
      topP?: number | undefined
      topK?: number | undefined
      minP?: number | undefined
      presencePenalty?: number | undefined
      repetitionPenalty?: number | undefined
    }
  >
  openRouterModel: string
  blockedModelMakers: Array<'anthropic' | 'openai' | 'google' | 'deepseek' | 'mistral' | 'xai'>
  openAiServiceTier: '' | 'auto' | 'default' | 'flex' | 'fast' | 'priority' | 'scale'
  openAiForceChatCompletions: boolean
  openRouterZdrOnly: boolean
  openRouterAllowTraining: boolean
  openRouterFreeMode: boolean
  localSubagentsEnabled: boolean
  localTodoItemsEnabled: boolean
  postTurnReviewMinChangedLines: number
  claudePlanMonthlyFeeUsd: number | null
  bundledCursorSkillsEnabled: boolean
  bundledSkillPluginOverrides: Record<string, boolean>
  skillsEnabled: boolean
  skillExternalLinkWarnings: boolean
  skillSandboxGuidance: boolean
  skillPluginPaths: Array<string>
  subagentsEnabled: boolean
  externalApiSafety: boolean
  githubBackend: 'auto' | 'cli' | 'api'
  gitAttributionEnabled: boolean
  gitThreadLinksEnabled: boolean
  remoteAgentBaseUrl: string
  remoteAgentAutoCreatePR: boolean
  remoteAgentWorkOnCurrentBranch: boolean
  preferAcpOverCloudAgent: boolean
  gitCommitSshAgentSocketAccess: boolean
  registeredAcpAgents: Array<{
    id: string
    title: string
    command: string
    args?: Array<string> | undefined
    env?: Record<string, string> | undefined
    model?: string | undefined
    availableModels?:
      | Array<{ value: string; label: string; description?: string | undefined }>
      | undefined
    modelsProbedAt?: number | undefined
    permissionMode?: string | undefined
    availablePermissionModes?:
      | Array<{ value: string; label: string; description?: string | undefined }>
      | undefined
    configOptions?: Record<string, string> | undefined
    availableConfigOptions?:
      | Array<{
          configId: string
          name: string
          category: 'mode' | 'model' | 'model_config' | 'thought_level' | 'other'
          description?: string | undefined
          currentValue: string
          choices: Array<{ value: string; label: string; description?: string | undefined }>
        }>
      | undefined
    sandbox?:
      | {
          allowedDomains: Array<string>
          allowMacOsTrustd?: boolean | undefined
          homeDirs?: Array<string> | undefined
          scratchPaths?: Array<string> | undefined
        }
      | false
      | undefined
    enabled: boolean
  }>
  browserToolsEnabled: boolean
  vncEnabled: boolean
  browserAllowedOrigins: Array<string>
  openLinksInBuiltInBrowser: boolean
  alertOnInteraction: boolean
  alertOnThreadFinished: boolean
  alertSystemNotification: boolean
  alertSound: boolean
  alertBounce: boolean
  acpAutoApproveEditsWithBackup: boolean
  acpAutoApproveNativeBridgeTools: boolean
  worktreeAutoApproveEdits: boolean
  modelClassifierEnabled: boolean
  nextStepSuggestionEnabled: boolean
  conciseThreadsEnabled: boolean
  containerRunsEnabled: boolean
  advisorModel: string
  orchestrationStrategyEnabled: boolean
  orchestrationWorkerModel: string
  readTerminalEnabled: boolean
  shareTerminalHistoryEnabled: boolean
  developerMode: boolean
  customInstructions: string
  onboardingCompleted: boolean
  envKeyAutoDetectEnabled: boolean
  sshStrictHostKeys: 'accept-new' | 'strict'
  sshWorkspaceEnabled: boolean
  acpOverSshEnabled: boolean
  sshWorkspaceHosts: Array<{
    id: string
    label: string
    host: string
    port?: number | undefined
    user?: string | undefined
    identityFile?: string | undefined
    forwardAgent?: boolean | undefined
  }>
  trustedSshHosts: Array<string>
  classifierProviders: { version: 1; profiles: ClassifierProfile[] }
  safetyScreeningClassifier: string
  backgroundClassifier: string
  windowBounds: { x?: number | undefined; y?: number | undefined; width: number; height: number }
  localServerUrl: string
  safetyClassifierEnabled: boolean
  safetyExternalDenyThreshold: number
  safetyModel: string
  reviewModel: string
  autoRunSandboxCommands: boolean
  shellAutoApprovalLevel: 'off' | 'read' | 'local-write' | 'remote-write'
  trustedShellCommands: Array<string>
  mcpAutoAllowReadOnly: boolean
  toolPermissionOverrides: Record<string, 'allow' | 'ask' | 'block'>
  cursorHooksEnabled: boolean
  defaultReadonlyMode: boolean
  safeInstallEnabled: boolean
  mockFollowUps: boolean
  webAllowedOrigins: Array<string>
  webAllowUserApproval: boolean
  browserAllowUserApproval: boolean
  approvedProviderHosts: Array<string>
  providerAllowUserApproval: boolean
  extraProviders: Array<{
    slug: string
    label?: string | undefined
    baseUrl?: string | undefined
    keyPrefix?: string | undefined
    apiStyle?: 'chat-completions' | 'responses' | undefined
    models?:
      | Array<{
          id: string
          contextWindow?: number | undefined
          inputPricePerMTok?: number | undefined
          outputPricePerMTok?: number | undefined
        }>
      | undefined
    fallbackContextWindow?: number | undefined
    includeUsage?: boolean | undefined
    extraBody?: Record<string, unknown> | undefined
  }>
  openRouterPricing: Record<
    string,
    {
      inputPricePerMTok: number
      outputPricePerMTok: number
      cacheReadPricePerMTok?: number | undefined
      cacheCreationPricePerMTok?: number | undefined
    }
  >
  modelCardProbeCache: Record<string, { ok: boolean; at: number }>
}

/** Missing or invalid values are omitted; sections own their defaults. */
export type SettingsSnapshot = { [K in keyof SettingsValues]?: SettingsValues[K] | undefined }

/** Dedicated credential, security and host-owned values are never ordinary updates. */
type DedicatedSettingKey =
  | 'trustedSshHosts'
  | 'classifierProviders'
  | 'safetyScreeningClassifier'
  | 'backgroundClassifier'
  | 'windowBounds'
  | 'localServerUrl'
  | 'safetyClassifierEnabled'
  | 'safetyExternalDenyThreshold'
  | 'safetyModel'
  | 'reviewModel'
  | 'autoRunSandboxCommands'
  | 'shellAutoApprovalLevel'
  | 'trustedShellCommands'
  | 'mcpAutoAllowReadOnly'
  | 'toolPermissionOverrides'
  | 'cursorHooksEnabled'
  | 'defaultReadonlyMode'
  | 'safeInstallEnabled'
  | 'mockFollowUps'
  | 'webAllowedOrigins'
  | 'webAllowUserApproval'
  | 'browserAllowUserApproval'
  | 'approvedProviderHosts'
  | 'providerAllowUserApproval'
  | 'extraProviders'
  | 'openRouterPricing'
  | 'modelCardProbeCache'

/** Ordinary preferences only. Role assignments merge with the latest saved role map. */
export type SettingsUpdate = {
  [K in Exclude<keyof SettingsValues, DedicatedSettingKey>]?: SettingsValues[K] | undefined
} & { roleAssignments?: Record<string, string> | undefined }
