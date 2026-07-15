import type { StreamChunk, UsageDelta, ContextBreakdown } from '@shared/types'
import type { RightPanelMode, ActiveDiff } from '@shared/types/state.ts'
import type { SkillSummary } from '@shared/types/skills.ts'
import type { CursorPluginSummary } from '@shared/types/cursor-plugins.ts'
import type { HookSummary } from '@shared/types/hooks.ts'
import type { ProjectInstructionSummary } from '@shared/types/instructions.ts'
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
import type { AcpModelSelector, AcpAutoSetupResult } from '@shared/types/acp.ts'
import type { ExternalEditorList } from '@shared/types/editors.ts'

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
    set: (root: string) => Promise<string>
    isTrusted: () => Promise<boolean>
    setTrusted: (trusted: boolean) => Promise<McpServerStatus[]>
    onOpened: (handler: (root: string) => void) => () => void
  }
  browser: {
    onOpenTab: (handler: (url: string) => void) => () => void
  }
  fs: {
    readFile: (path: string) => Promise<string>
    writeFile: (path: string, content: string) => Promise<void>
    readdir: (path: string) => Promise<string[]>
    listDir: (path: string) => Promise<{ name: string; isDir: boolean }[]>
    watch: (path: string) => Promise<void>
    unwatch: (path: string) => Promise<void>
    onChanged: (handler: (path: string, content: string | null) => void) => () => void
  }
  agent: {
    run: (threadId: string, prompt: string) => Promise<void>
    estimateContext: (threadId: string, payload: string) => Promise<ContextBreakdown>
    abort: (threadId: string) => Promise<void>
    retryReview: (threadId: string, payload: string) => Promise<void>
    retryComparison: (threadId: string, payload: string) => Promise<void>
    clearHistory: (threadId: string) => Promise<void>
    refreshModelContext: () => Promise<void>
    suggestTitle: (text: string) => Promise<string | null>
    suggestTerminalTitle: (text: string) => Promise<string | null>
    suggestCommandSummary: (commands: string[]) => Promise<string | null>
    suggestFollowUps: (contextJson: string) => Promise<FollowUpSuggestion[]>
    onChunk: (handler: (threadId: string, chunk: StreamChunk) => void) => () => void
    onApprovalRequest: (
      handler: (req: {
        id: string
        threadId?: string
        title: string
        body: string
        type: string
        allowRemember?: boolean
        rememberLabel?: string
      }) => void,
    ) => () => void
    onAskUserRequest: (
      handler: (req: {
        id: string
        threadId?: string
        questions: { question: string; options?: string[] }[]
      }) => void,
    ) => () => void
    onShellOutput: (handler: (data: string, toolCallId: string | null) => void) => () => void
    onUsage: (handler: (threadId: string, usage: UsageDelta) => void) => () => void
    onRefreshContextEstimate: (handler: () => void) => () => void
  }
  diff: {
    approve: (path: string) => Promise<void>
    reject: (path: string) => Promise<void>
    approveAll: () => Promise<void>
    rejectAll: () => Promise<void>
    content: (path: string) => Promise<ActiveDiff | null>
    onShowDiff: (
      handler: (path: string, before: string, after: string, lang: string) => void,
    ) => () => void
    onQueued: (handler: (entries: { path: string; language: string }[]) => void) => () => void
    onConflict: (handler: (paths: string[]) => void) => () => void
  }
  approval: {
    respond: (id: string, approved: boolean, remember?: boolean) => Promise<void>
  }
  ask: {
    respond: (id: string, answers: string[]) => Promise<void>
  }
  sshPrompt: {
    respond: (id: string, value: string) => Promise<void>
    onRequest: (
      handler: (req: { id: string; prompt: string; kind: 'confirm' | 'secret' }) => void,
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
    catalog: (
      projectId: string,
      query?: string,
    ) => Promise<import('@shared/types').ThreadCatalogHit[]>
  }
  openRouter: {
    models: () => Promise<Array<{ id: string; name: string }>>
  }
  models: {
    /** Whether any available chat model reaches the recommended context window. */
    chatDefaultContextHealth: () => Promise<{
      hasDecentChatDefault: boolean
      minimum: number
      bestAvailableContext: number | null
    }>
  }
  lmStudio: {
    test: (
      url: string,
      apiKey?: string,
    ) => Promise<{ ok: boolean; models?: string[]; error?: string }>
    models: () => Promise<string[]>
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
  }
  acp: {
    /** Detect known ACP agents installed/running on this device (for the Settings panel). */
    detectAgents: () => Promise<DetectedAcpAgent[]>
    /**
     * Probe a configured agent for the models it offers (spawns it, opens a
     * throwaway session). `null` when the agent exposes no model selector.
     */
    listModels: (agentId: string) => Promise<AcpModelSelector | null>
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
    onKeyboardShortcuts: (handler: () => void) => () => void
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
      mcpAutoAllowReadOnly: boolean
      defaultReadonlyMode: boolean
      webAllowedOrigins: string[]
      webAllowUserApproval: boolean
      trustedShellCommands?: string[]
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
    ) => Promise<import('../main/services/storage/knowledge-store.ts').KnowledgeNote>
    update: (
      id: string,
      prompt: string,
      notes: string | undefined,
      status: import('../main/tools/roadmap-tools.ts').RoadmapStatus,
      issue?: string,
    ) => Promise<import('../main/services/storage/knowledge-store.ts').KnowledgeNote | null>
    delete: (id: string) => Promise<boolean>
    issueUrl: (ref: string) => Promise<string | null>
    openIssues: () => Promise<{
      slug: string
      issues: import('../shared/types/git.ts').GhIssueSummary[]
    }>
    importIssues: (
      issues: { number: number; title: string; body: string }[],
    ) => Promise<import('../main/services/storage/knowledge-store.ts').KnowledgeNote[]>
    checkFit: (
      id: string,
    ) => Promise<import('../main/services/roadmap-fit-check.ts').RoadmapFitResult>
  }
  skills: {
    list: () => Promise<SkillSummary[]>
  }
  plugins: {
    list: () => Promise<CursorPluginSummary[]>
  }
  hooks: {
    list: () => Promise<HookSummary[]>
  }
  instructions: {
    list: () => Promise<ProjectInstructionSummary[]>
  }
  terminal: {
    create: (cols: number, rows: number) => Promise<string>
    write: (sessionId: string, data: string) => Promise<void>
    resize: (sessionId: string, cols: number, rows: number) => Promise<void>
    destroy: (sessionId: string) => Promise<void>
    onOutput: (handler: (sessionId: string, data: string) => void) => () => void
    onExit: (handler: (sessionId: string, code: number) => void) => () => void
  }
  git: {
    isAvailable: () => Promise<boolean>
    status: () => Promise<GitStatusResult | null>
    /** Live +/- line totals across staged + unstaged changes, or null when clean. */
    changeStats: () => Promise<{ additions: number; deletions: number } | null>
    fileDiff: (path: string, staged: boolean) => Promise<GitFileDiff | null>
    branchStatus: (forBranch?: string) => Promise<GitBranchStatus>
    checkoutBranch: (branch: string) => Promise<void>
    listBranches: () => Promise<GitBranchInfo[]>
    getDefaultBranch: () => Promise<string | null>
    /** The pre-session worktree backup taken this session, or null when none. */
    sessionBackup: () => Promise<SessionBackup | null>
    /** Revert the session backup's captured paths to their pre-session content. */
    restoreBackup: () => Promise<boolean>
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
    /** Open the active workspace root in a detected editor. */
    open: (editorId: string) => Promise<void>
  }
  panes: {
    /** Detach a right-panel pane into its own window. */
    popout: (mode: RightPanelMode) => Promise<void>
  }
}

declare global {
  interface Window {
    api: ApiClient
  }
}
