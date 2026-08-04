import type { StreamChunk, ContextBreakdown } from '@shared/types'
import type { AutoApprovalLevel } from '@shared/auto-approval.ts'
import type { RightPanelMode, ActiveDiff } from '@shared/types/state.ts'
import type { SkillSummary } from '@shared/types/skills.ts'
import type { CursorPluginSummary } from '@shared/types/cursor-plugins.ts'
import type { HooksListResult, HookTestRequest, HookTestResult } from '@shared/types/hooks.ts'
import type { PacksListResult } from '@shared/types/packs.ts'
import type {
  AutomationSchedule,
  AutomationScheduleInput,
  AutomationTriggerEvent,
} from '@shared/types/automations.ts'
import type { ProjectInstructionSummary } from '@shared/types/instructions.ts'
import type { CursorRuleSummary } from '@shared/types/cursor-rules.ts'
import type {
  GitFileDiff,
  GitStatusResult,
  GitBranchStatus,
  GitBranchInfo,
  SessionBackup,
  GhCliStatus,
  GhPrChecksState,
  GhPrDetails,
  GhPrFileDiff,
  GhPrSummary,
  PrActionResult,
} from '@shared/types/git.ts'
import type { McpServerStatus, CuratedMcpServerStatus } from '@shared/types/mcp.ts'
import type { RemoteAgentPrIndexEntry } from '@shared/remote-agent-link.ts'
import type { CanvasArtefact } from '@shared/types/canvas.ts'
import type { FollowUpSuggestion } from '@shared/follow-ups/types.ts'
import type {
  ExtraProvider,
  ExtraProviderModel,
  StoredExtraProvider,
} from '@copse/llm/extra-providers.ts'
import type { DetectedAcpAgent } from '@shared/acp-known-agents.ts'
import type { AcpAgentProbe, AcpAutoSetupResult } from '@shared/types/acp.ts'
import type { ExternalEditorList } from '@shared/types/editors.ts'
import type {
  PreparedThreadCheckout,
  ThreadCheckoutPreview,
  ThreadWorktreeChoice,
} from '@shared/types/worktree.ts'
import type { GuardedYoloState } from '@shared/types/guarded-yolo.ts'
import type { PackBrowserTabRequest } from '@shared/types/pack-browser.ts'

export type { DetectedAcpAgent }

/** Fixed cloud providers with a user-supplied API key (presets/customs use slugs). */
export type ApiKeyProvider =
  'anthropic' | 'openai' | 'cursor' | 'openrouter' | 'mistral' | 'gemini' | 'deepseek'

export type { ExtraProvider, ExtraProviderModel, StoredExtraProvider }

/** A provider API key discovered in the environment, masked for display. */
export interface DetectedEnvKey {
  /** Provider slug (e.g. `anthropic`, `lmstudio`). */
  provider: string
  /** The environment variable it was read from (e.g. `ANTHROPIC_API_KEY`). */
  envVar: string
  /** Where it was found: `environment` or a shell file label (e.g. `~/.zshrc`). */
  source: string
  /** Masked preview of the key — the raw value never crosses IPC. */
  masked: string
  /** Whether a key for this provider is already saved in Settings. */
  alreadyConfigured: boolean
}

export interface ApiClient {
  workspace: {
    open: () => Promise<string | null>
    get: () => Promise<string | null>
    set: (root: string, sshHost?: string) => Promise<string>
    isTrusted: () => Promise<boolean>
    setTrusted: (trusted: boolean) => Promise<McpServerStatus[]>
    unsandboxedProjectHooks: () => Promise<{ event: string; command: string }[]>
    onOpened: (handler: (root: string) => void) => () => void
  }
  browser: {
    onOpenTab: (handler: (url: string) => void) => () => void
    onPackTabRequest: (
      handler: (
        request: PackBrowserTabRequest,
      ) => Promise<{ tabId: string; webContentsId: number }>,
    ) => () => void
  }
  security: {
    getGuardedYolo: (threadId: string) => Promise<GuardedYoloState>
    enableGuardedYolo: (threadId: string) => Promise<GuardedYoloState>
    disableGuardedYolo: (threadId: string) => Promise<GuardedYoloState>
    onGuardedYoloChanged: (handler: (state: GuardedYoloState) => void) => () => void
  }
  fs: {
    readFile: (projectId: string, threadId: string, path: string) => Promise<string>
    writeFile: (projectId: string, threadId: string, path: string, content: string) => Promise<void>
    readdir: (projectId: string, threadId: string, path: string) => Promise<string[]>
    listDir: (
      projectId: string,
      threadId: string,
      path: string,
    ) => Promise<{ name: string; isDir: boolean }[]>
    watch: (projectId: string, threadId: string, path: string) => Promise<void>
    unwatch: (projectId: string, threadId: string, path: string) => Promise<void>
    onChanged: (
      handler: (projectId: string, threadId: string, path: string, content: string | null) => void,
    ) => () => void
  }
  agent: {
    run: (projectId: string, threadId: string, prompt: string) => Promise<void>
    describeImages: (
      projectId: string,
      threadId: string,
      model: string,
      userPrompt: string,
      images: string[],
    ) => Promise<{ text: string }>
    prepareCheckout: (
      projectId: string,
      threadId: string,
      prompt: string,
      choice: ThreadWorktreeChoice,
      model?: string,
    ) => Promise<PreparedThreadCheckout>
    previewCheckout: (
      projectId: string,
      choice: ThreadWorktreeChoice,
      model?: string,
    ) => Promise<ThreadCheckoutPreview>
    estimateContext: (
      projectId: string,
      threadId: string,
      payload: string,
    ) => Promise<ContextBreakdown>
    abort: (threadId: string) => Promise<void>
    retryReview: (projectId: string, threadId: string, payload: string) => Promise<void>
    retryComparison: (projectId: string, threadId: string, payload: string) => Promise<void>
    clearHistory: (projectId: string, threadId: string) => Promise<void>
    refreshModelContext: () => Promise<void>
    suggestTitle: (text: string) => Promise<string | null>
    suggestTerminalTitle: (text: string) => Promise<string | null>
    suggestCommandSummary: (commands: string[]) => Promise<string | null>
    suggestToolTurnSummary: (actions: string[]) => Promise<string | null>
    suggestFollowUps: (contextJson: string) => Promise<FollowUpSuggestion[]>
    onChunk: (handler: (threadId: string, chunk: StreamChunk) => void) => () => void
    onApprovalRequest: (
      handler: (req: {
        id: string
        threadId?: string
        title: string
        body: string
        bodyAdvice?: string
        bodyFooter?: string
        type: string
        allowRemember?: boolean
        rememberLabel?: string
        showWhileSettingsOpen?: boolean
        comparisonModels?: { a: string; b: string; judge: string }
      }) => void,
    ) => () => void
    onApprovalCancelled: (handler: (req: { id: string }) => void) => () => void
    onAskUserRequest: (
      handler: (req: {
        id: string
        threadId?: string
        questions: { question: string; options?: string[] }[]
      }) => void,
    ) => () => void
    onShellOutput: (handler: (data: string, toolCallId: string | null) => void) => () => void
    onRefreshContextEstimate: (handler: () => void) => () => void
    /**
     * An async hook's `queueMessage` output (decision 4), bridged from the host.
     * The renderer lands it in the thread's pending queue with origin + epoch;
     * a stale-epoch send-now is downgraded to held (decision 16).
     */
    onHookQueueMessage: (
      handler: (payload: import('@shared/types/hooks.ts').HookQueueMessagePayload) => void,
    ) => () => void
  }
  diff: {
    approve: (projectId: string, threadId: string, path: string) => Promise<void>
    reject: (projectId: string, threadId: string, path: string) => Promise<void>
    approveAll: (projectId: string, threadId: string) => Promise<void>
    rejectAll: (projectId: string, threadId: string) => Promise<void>
    content: (projectId: string, threadId: string, path: string) => Promise<ActiveDiff | null>
    onShowDiff: (
      handler: (
        projectId: string,
        threadId: string,
        path: string,
        before: string,
        after: string,
        lang: string,
      ) => void,
    ) => () => void
    onQueued: (
      handler: (
        projectId: string,
        threadId: string,
        entries: { path: string; language: string }[],
      ) => void,
    ) => () => void
    onConflict: (
      handler: (projectId: string, threadId: string, paths: string[]) => void,
    ) => () => void
  }
  approval: {
    respond: (
      id: string,
      approved: boolean,
      remember?: boolean,
      comparisonModels?: { a: string; b: string; judge: string },
    ) => Promise<void>
  }
  ask: {
    respond: (id: string, answers: string[]) => Promise<void>
  }
  alerts: {
    threadFinished: (threadId: string, title: string) => Promise<void>
  }
  sshPrompt: {
    respond: (id: string, value: string, remember?: boolean) => Promise<void>
    onRequest: (
      handler: (req: { id: string; prompt: string; kind: 'confirm' | 'secret' }) => void,
    ) => () => void
  }
  updatePrompt: {
    respond: (id: string, buttonIndex: number) => Promise<void>
    onRequest: (
      handler: (req: {
        id: string
        message: string
        detail?: string
        buttons: string[]
        defaultIndex?: number
        cancelIndex?: number
      }) => void,
    ) => () => void
    onDevNotice: (handler: () => void) => () => void
  }
  sshWorkspace: {
    listHosts: () => Promise<import('@shared/types/ssh-workspace.ts').SshWorkspaceHost[]>
    listConfigAliases: () => Promise<import('@shared/types/ssh-workspace.ts').SshWorkspaceHost[]>
    getStates: () => Promise<import('@shared/types/ssh-workspace.ts').SshConnectionState[]>
    connect: (
      hostId: string,
    ) => Promise<import('@shared/types/ssh-workspace.ts').SshConnectionState[]>
    disconnect: (
      hostId: string,
    ) => Promise<import('@shared/types/ssh-workspace.ts').SshConnectionState[]>
    reconnect: (
      hostId: string,
    ) => Promise<import('@shared/types/ssh-workspace.ts').SshConnectionState[]>
    listDirectory: (
      hostId: string,
      dirPath: string,
    ) => Promise<import('@shared/types/ssh-workspace.ts').SshRemoteDirEntry[]>
    registerRoot: (hostId: string, dirPath: string) => Promise<string>
    onConnectionChanged: (
      handler: (states: import('@shared/types/ssh-workspace.ts').SshConnectionState[]) => void,
    ) => () => void
  }
  mcp: {
    list: () => Promise<McpServerStatus[]>
    reload: () => Promise<McpServerStatus[]>
    setEnabled: (name: string, enabled: boolean) => Promise<McpServerStatus[]>
    listCurated: () => Promise<CuratedMcpServerStatus[]>
    setCuratedEnabled: (name: string, enabled: boolean) => Promise<CuratedMcpServerStatus[]>
    onStatusChanged: (handler: (statuses: McpServerStatus[]) => void) => () => void
  }
  canvas: {
    onArtefact: (handler: (artefact: CanvasArtefact) => void) => () => void
  }
  storage: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
  }
  threads: {
    loadProject: (projectId: string) => Promise<import('@shared/types').Thread[]>
    create: (projectId: string, thread: import('@shared/types').Thread) => Promise<void>
    appendMessage: (
      projectId: string,
      threadId: string,
      message: import('@shared/types').Message,
    ) => Promise<void>
    updateMeta: (
      projectId: string,
      threadId: string,
      patch: Partial<Omit<import('@shared/types').Thread, 'messages'>>,
    ) => Promise<void>
    delete: (projectId: string, threadId: string) => Promise<void>
    /**
     * Zip the thread's whole on-disk directory (spine, prose, blobs, plans,
     * subagents) for download. The JSONL export stays the portable single-file
     * transcript; this is the full-fidelity copy of the store directory.
     */
    exportArchive: (projectId: string, threadId: string) => Promise<Uint8Array<ArrayBuffer>>
    /**
     * Seed a fork's provider-format history from the thread it branched off.
     * Omit `throughMessageId` (or pass the source's last message id) to copy the
     * sidecar verbatim; an earlier id rebuilds history from the transcript slice.
     */
    fork: (
      projectId: string,
      sourceThreadId: string,
      targetThreadId: string,
      throughMessageId?: string,
    ) => Promise<import('@shared/types').ForkedHistoryResult>
    catalog: (
      projectId: string,
      query?: string,
    ) => Promise<import('@shared/types').ThreadCatalogHit[]>
    /** Store dirs with threads but no project entry — orphans to re-attach (#997). */
    listOrphans: () => Promise<import('@shared/types').OrphanProjectStore[]>
  }
  archive: {
    /**
     * Store an archive the user attached to a chat and return the reference the
     * agent is given. Pass `bytes` for a file dropped from outside the app, or
     * `path` for one already in the workspace (referenced, not copied). The
     * archive itself never becomes model content — see `read_archive`.
     */
    attach: (
      projectId: string,
      threadId: string,
      archive: { name: string; bytes?: Uint8Array; path?: string },
    ) => Promise<import('@shared/archive/archive-media.ts').ArchiveAttachmentRef>
  }
  video: {
    /**
     * Store a video the user attached to a chat and return the reference the
     * agent is given. Pass `bytes` for a file dropped from outside the app, or
     * `path` for one already in the workspace (referenced, not copied). The
     * video itself never becomes model content — see `video_frames`.
     */
    attach: (
      projectId: string,
      threadId: string,
      video: { name: string; mimeType: string; bytes?: Uint8Array; path?: string },
    ) => Promise<import('@shared/video/video-media.ts').VideoAttachmentRef>
    /**
     * Read an attached video back for inline playback. Rejects for anything
     * outside the chat store or the workspace, and for files over the preview
     * size limit — the message is meant to be shown to the user.
     */
    read: (path: string) => Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string }>
  }
  openRouter: {
    models: () => Promise<
      Array<{
        id: string
        name: string
        inputPricePerMTok: number | null
        outputPricePerMTok: number | null
        supportsImages?: boolean
      }>
    >
  }
  models: {
    /** Whether any available chat model reaches the recommended context window. */
    chatDefaultContextHealth: () => Promise<{
      hasDecentChatDefault: boolean
      minimum: number
      bestAvailableContext: number | null
    }>
    /**
     * Concrete model id for the plan/price Pareto best-value default
     * (`auto:best-value` setting expands to this on new chats / agent runs).
     */
    bestValueDefault: () => Promise<string>
  }
  intellect: {
    /** Live Artificial Analysis model feed; empty models when no key stored. */
    liveModels: () => Promise<{
      ok: boolean
      models: Array<{
        id: string
        intellect: number
        inputPricePerMTok?: number
        outputPricePerMTok?: number
      }>
      indexVersion?: string | number
      error?: string
    }>
  }
  lmStudio: {
    test: (
      url: string,
      apiKey?: string,
    ) => Promise<{ ok: boolean; models?: string[]; error?: string }>
    models: () => Promise<string[]>
    modelInfo: () => Promise<Array<{ id: string; supportsImages?: boolean }>>
    detect: (
      url?: string,
      apiKey?: string,
    ) => Promise<{
      serverRunning: boolean
      serverUrl: string
      installDetected: boolean
      models: string[]
      modelContexts: Record<string, number>
      preferredPresent: string[]
      preferredMissing: string[]
      error?: string
    }>
    download: (
      modelId: string,
      url?: string,
      apiKey?: string,
    ) => Promise<{
      ok: boolean
      jobId?: string
      status?: string
      totalSizeBytes?: number
      error?: string
    }>
    downloadStatus: (
      jobId: string,
      url?: string,
      apiKey?: string,
    ) => Promise<{
      ok: boolean
      jobId: string
      status?: string
      totalSizeBytes?: number
      downloadedBytes?: number
      error?: string
    }>
  }
  remoteAgent: {
    downloadArtifact: (agentId: string, path: string) => Promise<string>
    artifactImageDataUrl: (agentId: string, path: string) => Promise<string>
    /** Live Cursor Cloud Agent models from `GET /v1/models` (empty without a key). */
    models: () => Promise<Array<{ id: string; label: string }>>
    /**
     * List Cursor cloud agents for the account and import those matching the
     * given project's GitHub repo (and not already linked) as local thread stubs.
     * Omit `projectId` to use main's active project.
     */
    discoverExternal: (projectId?: string) => Promise<{
      imported: Array<{ threadId: string; agentId: string; title: string; url: string }>
      scanned: number
      skippedLinked: number
      skippedWrongRepo: number
      skippedInactive: number
    }>
  }
  acp: {
    /** Detect known ACP agents installed/running on this device (for the Settings panel). */
    detectAgents: () => Promise<DetectedAcpAgent[]>
    /**
     * Probe a configured agent for the models and session (permission) modes it
     * offers (spawns it, opens a throwaway session). Each selector is `null`
     * when the agent exposes none of that kind (issue #607).
     */
    probeAgent: (agentId: string) => Promise<AcpAgentProbe>
    /**
     * "Just works" setup for the curated presets (Claude, Cursor): detect
     * clients, Socket-Firewall-install missing npm adapters, register + detect
     * models. Safe to call on every ACP settings-tab open (idempotent).
     */
    autoSetup: () => Promise<AcpAutoSetupResult>
  }
  menu: {
    onSettings: (handler: () => void) => () => void
    onNewThread: (handler: () => void) => () => void
    onTogglePanel: (handler: () => void) => () => void
    onShowExplorer: (handler: () => void) => () => void
    onShowTerminal: (handler: () => void) => () => void
    onShowChanges: (handler: () => void) => () => void
    onShowBrowser: (handler: () => void) => () => void
    onFocusBrowserUrlBar: (handler: () => void) => () => void
    onKeyboardShortcuts: (handler: () => void) => () => void
    onUiScaleZoomIn: (handler: () => void) => () => void
    onUiScaleZoomOut: (handler: () => void) => () => void
    onUiScaleReset: (handler: () => void) => () => void
  }
  settings: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    setSecurity: (prefs: {
      localServerUrl: string
      safetyClassifierEnabled: boolean
      safetyExternalDenyThreshold: number
      safetyModel: string
      reviewModel?: string
      autoRunSandboxCommands: boolean
      // Optional so bundles that don't render the toggle (e.g. the LM Studio
      // connection save) don't clobber the persisted value.
      cursorHooksEnabled?: boolean
      mcpAutoAllowReadOnly: boolean
      defaultReadonlyMode: boolean
      webAllowedOrigins: string[]
      webAllowUserApproval: boolean
      approvedProviderHosts?: string[]
      providerAllowUserApproval?: boolean
      trustedShellCommands?: string[]
      // Highest auto-approval tier for recognised low-risk shell shapes. Optional so
      // bundles that don't render the picker don't reset the user's choice.
      shellAutoApprovalLevel?: AutoApprovalLevel
    }) => Promise<void>
    getKey: (provider: string) => Promise<boolean>
    /**
     * At-rest encryption state for a stored key: `true` = OS-encrypted, `false` =
     * base64 plaintext fallback (OS keyring unavailable), `null` = no key stored.
     */
    getKeyEncrypted: (provider: string) => Promise<boolean | null>
    setKey: (
      provider: string,
      key: string,
      opts?: { allowPlaintext?: boolean },
    ) => Promise<{ ok: true } | { ok: false; reason: 'plaintext-consent-required' }>
    /** Availability keyed by provider slug: fixed cloud providers + every resolved extra provider. */
    availableProviders: () => Promise<Record<string, boolean>>
    validateKey: (
      provider: string,
      key: string,
    ) => Promise<{ ok: boolean; error?: string; formatOk?: boolean }>
    /**
     * Scan `process.env` and well-known shell start-up files for provider API
     * keys the user already has. Returns masked previews only — raw secrets never
     * cross IPC. Requires no consent (read-only preview); importing does.
     */
    scanEnvKeys: () => Promise<DetectedEnvKey[]>
    /**
     * Import detected environment keys into Settings for any provider not already
     * configured. Gated on the `envKeyAutoDetectEnabled` consent flag.
     */
    importEnvKeys: () => Promise<{
      imported: { provider: string; source: string }[]
      skipped: { provider: string; reason: string }[]
    }>
    /** Effective extra-provider list: shipped presets merged with stored overrides/customs. */
    extraProviders: () => Promise<ExtraProvider[]>
    /**
     * Every known per-MTok rate outside the static cloud catalog (cached
     * OpenRouter catalog rates merged with extra-provider rates), keyed by the
     * model selection string. Feeds the footer cost estimate.
     */
    modelPricing: () => Promise<import('@copse/llm/model-pricing.ts').ModelPricingMap>
    /** Insert/replace a preset override or custom provider; returns the resolved list. */
    saveExtraProvider: (
      record: Omit<StoredExtraProvider, 'slug'> & { slug?: string },
    ) => Promise<ExtraProvider[]>
    /** Remove a custom provider (or revert a preset override); returns the resolved list. */
    deleteExtraProvider: (slug: string) => Promise<ExtraProvider[]>
    /** List models from an OpenAI-compatible `/models` endpoint for the add/edit form. */
    fetchProviderModels: (
      baseUrl: string,
      apiKey?: string,
    ) => Promise<{
      ok: boolean
      models: { id: string; contextLength: number | null }[]
      error?: string
    }>
    /**
     * Fetch the Hugging Face router catalogue and persist priced, provider-pinned
     * models onto the `huggingface` provider. Uses the stored/env token when none
     * is passed. Runs automatically when the HF token is saved.
     */
    refreshHuggingFaceModels: (
      apiKey?: string,
    ) => Promise<{ ok: boolean; count: number; error?: string }>
  }
  appIcon: {
    apply: () => Promise<void>
  }
  usage: {
    record: (input: import('@shared/usage/usage-event.ts').UsageRecordInput) => Promise<void>
    getSummary: () => Promise<import('@shared/usage/aggregate-usage.ts').UsageSummary>
    getPlanUsage: () => Promise<import('@copse/plan-usage').PlanUsageSnapshot>
    getPlanWorthIt: () => Promise<import('@shared/usage/plan-worth-it.ts').PlanWorthItPayload>
    setClaudePlanMonthlyFee: (
      fee: number | null,
    ) => Promise<import('@shared/usage/plan-worth-it.ts').PlanWorthItPayload>
  }
  decisions: {
    list: (projectId?: string) => Promise<import('@shared/threads/decision-log.ts').DecisionEvent[]>
    export: (projectId?: string) => Promise<{ path: string; count: number }>
  }
  index: {
    query: (pattern: string) => Promise<string[]>
    resolveFileReferences: (
      candidates: string[],
    ) => Promise<{ candidate: string; path: string; kind: 'file' | 'directory' }[]>
    status: () => Promise<import('@shared/types/index-status.ts').WorkspaceIndexStatus>
    onStatusChanged: (
      handler: (status: import('@shared/types/index-status.ts').WorkspaceIndexStatus) => void,
    ) => () => void
  }
  memories: {
    list: () => Promise<import('../main/services/storage/knowledge-store.ts').KnowledgeNote[]>
    create: (
      title: string,
      body: string,
      tags?: string[],
    ) => Promise<import('../main/services/storage/knowledge-store.ts').KnowledgeNote>
    update: (
      id: string,
      title: string,
      body: string,
      tags?: string[],
    ) => Promise<import('../main/services/storage/knowledge-store.ts').KnowledgeNote | null>
    delete: (id: string) => Promise<boolean>
  }
  roadmap: {
    list: () => Promise<import('../main/services/storage/knowledge-store.ts').KnowledgeNote[]>
    create: (
      prompt: string,
      notes?: string,
      issue?: string,
      attachments?: { name: string; mimeType: string; dataUrl: string }[],
    ) => Promise<import('../main/services/storage/knowledge-store.ts').KnowledgeNote>
    update: (
      id: string,
      prompt: string,
      notes: string | undefined,
      status: import('../main/tools/roadmap-tools.ts').RoadmapStatus,
      issue?: string,
      addAttachments?: { name: string; mimeType: string; dataUrl: string }[],
      removeAttachmentIds?: string[],
    ) => Promise<import('../main/services/storage/knowledge-store.ts').KnowledgeNote | null>
    attachmentData: (id: string, attachmentId: string) => Promise<string | null>
    setStatus: (
      id: string,
      status: import('../main/tools/roadmap-tools.ts').RoadmapStatus,
    ) => Promise<import('../main/services/storage/knowledge-store.ts').KnowledgeNote | null>
    setCategory: (
      id: string,
      category: string,
    ) => Promise<import('../main/services/storage/knowledge-store.ts').KnowledgeNote | null>
    delete: (id: string) => Promise<boolean>
    export: (format: import('../shared/roadmap/export.ts').RoadmapExportFormat) => Promise<{
      filename: string
      mimeType: string
      dataUrl: string
      bundled: boolean
      files: string[]
    }>
    issueUrl: (ref: string) => Promise<string | null>
    openIssues: (page: number) => Promise<{
      slug: string
      issues: import('../shared/types/git.ts').GhIssueSummary[]
      hasMore: boolean
    }>
    importIssues: (
      issues: { number: number; title: string; body: string }[],
    ) => Promise<import('../main/services/storage/knowledge-store.ts').KnowledgeNote[]>
    matchOpenIssues: (
      issues: { number: number; title: string; body: string }[],
    ) => Promise<import('../main/services/roadmap-issue-coverage.ts').RoadmapIssueCoverageMatch[]>
    checkFit: (
      id: string,
    ) => Promise<import('../main/services/roadmap-fit-check.ts').RoadmapFitResult>
    prepareReview: () => Promise<
      import('../main/services/roadmap-review.ts').RoadmapReviewPrepareResult
    >
    lastReviewAt: () => Promise<{
      lastReviewAt: string | null
      lastAcknowledgedBulkRun: string | null
      pendingBulkRun: string | null
    }>
    reviewItem: (
      id: string,
      commits: string,
      runId?: string,
    ) => Promise<import('../main/services/roadmap-review.ts').RoadmapReviewItemResult>
    reviewItemDeep: (
      id: string,
    ) => Promise<import('../main/services/roadmap-review.ts').RoadmapReviewItemResult>
    completeReview: (runId: string) => Promise<boolean>
    abortReview: (runId: string) => Promise<boolean>
    /** Subscribe to background roadmap changes (e.g. a complexity stamp landing
     * after a save returned). Returns an unsubscribe function. */
    onChanged: (handler: () => void) => () => void
    setThread: (
      id: string,
      threadId: string,
    ) => Promise<import('../main/services/storage/knowledge-store.ts').KnowledgeNote | null>
  }
  skills: {
    list: () => Promise<SkillSummary[]>
  }
  plugins: {
    list: () => Promise<CursorPluginSummary[]>
  }
  hooks: {
    list: () => Promise<HooksListResult>
    /** Dry-run one discovered hook against a synthetic payload for its event (G2). */
    test: (req: HookTestRequest) => Promise<HookTestResult>
  }
  packs: {
    /** Enumerate every registered pack with contributions + enablement + settings values (P3). */
    list: () => Promise<PacksListResult>
    /** Atomic enable/disable (P1 contract) — persists and flips the shared registry flag. */
    setEnabled: (id: string, enabled: boolean) => Promise<PacksListResult>
    /** Persist one pack-scoped setting value under the manifest's declared schema (P3). */
    setSetting: (id: string, key: string, value: unknown) => Promise<PacksListResult>
    /** Choose and register one pack directory through a native host dialog. */
    addSource: () => Promise<PacksListResult>
  }
  automations: {
    list: (projectId: string) => Promise<AutomationSchedule[]>
    upsert: (projectId: string, input: AutomationScheduleInput) => Promise<AutomationSchedule>
    remove: (projectId: string, scheduleId: string) => Promise<void>
    runNow: (projectId: string, scheduleId: string) => Promise<AutomationTriggerEvent>
    onTriggered: (handler: (event: AutomationTriggerEvent) => void) => () => void
  }
  instructions: {
    list: () => Promise<ProjectInstructionSummary[]>
  }
  cursorRules: {
    list: () => Promise<CursorRuleSummary[]>
  }
  terminal: {
    create: (
      cols: number,
      rows: number,
      meta: { label?: string; projectId: string; threadId: string | null },
    ) => Promise<string>
    write: (sessionId: string, data: string) => Promise<void>
    resize: (sessionId: string, cols: number, rows: number) => Promise<void>
    destroy: (sessionId: string) => Promise<void>
    setMeta: (
      sessionId: string,
      meta: { label?: string; threadId?: string | null },
    ) => Promise<void>
    setActive: (sessionId: string) => Promise<void>
    onOutput: (handler: (sessionId: string, data: string) => void) => () => void
    onExit: (handler: (sessionId: string, code: number) => void) => () => void
    /** Main asked for a fresh shell running `command` (e.g. an agent sign-in). */
    onRunCommand: (handler: (command: string) => void) => () => void
  }
  git: {
    isAvailable: (projectId: string, threadId: string) => Promise<boolean>
    status: (projectId: string, threadId: string) => Promise<GitStatusResult | null>
    /** Live +/- line totals across staged + unstaged changes, or null when clean. */
    changeStats: (
      projectId: string,
      threadId: string,
    ) => Promise<{ additions: number; deletions: number } | null>
    fileDiff: (
      projectId: string,
      threadId: string,
      path: string,
      staged: boolean,
    ) => Promise<GitFileDiff | null>
    /** Combined HEAD → working-tree diff for one file, or null when it matches HEAD. */
    workingFileDiff: (
      projectId: string,
      threadId: string,
      path: string,
    ) => Promise<GitFileDiff | null>
    branchStatus: (
      projectId: string,
      threadId: string,
      forBranch?: string,
    ) => Promise<GitBranchStatus>
    checkoutBranch: (projectId: string, threadId: string, branch: string) => Promise<void>
    listBranches: (projectId: string, threadId: string) => Promise<GitBranchInfo[]>
    getDefaultBranch: (projectId: string, threadId: string) => Promise<string | null>
    /** The pre-session worktree backup taken this session, or null when none. */
    sessionBackup: (projectId: string, threadId: string) => Promise<SessionBackup | null>
    /** Revert the session backup's captured paths to their pre-session content. */
    restoreBackup: (projectId: string, threadId: string) => Promise<boolean>
  }
  gh: {
    status: () => Promise<GhCliStatus>
    listMyOpenPrs: () => Promise<GhPrSummary[] | null>
    listWorkspaceOpenPrs: () => Promise<GhPrSummary[]>
    prChecks: (owner: string, repo: string, number: number) => Promise<GhPrChecksState>
    prDetails: (owner: string, repo: string, number: number) => Promise<GhPrDetails | null>
    prFileDiff: (
      owner: string,
      repo: string,
      number: number,
      path: string,
    ) => Promise<GhPrFileDiff | null>
    resolvePrUrl: (url: string) => Promise<{ owner: string; repo: string; number: number } | null>
    /** PRs in the active project opened by an agent this app launched (issue #690). */
    agentPrLinks: () => Promise<RemoteAgentPrIndexEntry[]>
    /** Re-run the failed workflow runs on the PR's head branch. */
    rerunFailedRuns: (owner: string, repo: string, number: number) => Promise<PrActionResult>
    /** Approve the pull request. */
    approvePr: (owner: string, repo: string, number: number) => Promise<PrActionResult>
    /** Mark a draft pull request ready for review. */
    markPrReady: (owner: string, repo: string, number: number) => Promise<PrActionResult>
    /** Enable merge-when-ready (auto-merge) with the repo's preferred strategy. */
    enableAutoMerge: (owner: string, repo: string, number: number) => Promise<PrActionResult>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
  }
  editors: {
    /** Installed external editors plus the sticky last-used default. */
    list: () => Promise<ExternalEditorList>
    /** Open the active task checkout in a detected editor. */
    open: (projectId: string, threadId: string, editorId: string) => Promise<void>
  }
  panes: {
    /** Detach a right-panel pane into its own window. */
    popout: (mode: RightPanelMode, seed?: unknown) => Promise<void>
    /** Read (once) the pane snapshot stashed when this pop-out was opened. */
    takePopoutSeed: (mode: RightPanelMode) => Promise<unknown>
    /** When an existing pop-out is re-focused for a different pane mode. */
    onSwitchMode: (handler: (mode: RightPanelMode) => void) => () => void
  }
}

declare global {
  interface Window {
    api: ApiClient
  }
}
