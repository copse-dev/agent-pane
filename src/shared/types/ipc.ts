import type { AutoApprovalLevel } from '../auto-approval.ts'
import type { StreamChunk } from './stream.ts'
import type { GitFileDiff, GitStatusResult, GitBranchStatus, GitPromptState } from './git.ts'
import type { McpServerStatus, CuratedMcpServerStatus } from './mcp.ts'

type Provider =
  | 'anthropic'
  | 'openai'
  | 'lmstudio'
  | 'cursor'
  | 'openrouter'
  | 'mistral'
  | 'gemini'
  | 'deepseek'
type CloudProvider = Exclude<Provider, 'lmstudio'>

interface AvailableProviders {
  anthropic: boolean
  openai: boolean
  cursor: boolean
  openrouter: boolean
  mistral: boolean
  gemini: boolean
  deepseek: boolean
}

// invoke channels (renderer → main, returns result)
export interface IpcInvokeMap {
  // Workspace
  'workspace:open': { args: []; result: string | null }
  'workspace:get': { args: []; result: string | null }
  'workspace:set': { args: [root: string, sshHost?: string]; result: string }

  // Full main-window state (sender-derived; pane popouts cannot mutate it)
  'main-window:get-navigation': {
    args: []
    result: import('./main-window.ts').MainWindowNavigation
  }
  'main-window:set-navigation': {
    args: [navigation: import('./main-window.ts').MainWindowNavigation]
    result: undefined
  }
  'main-window:get-browser-session': {
    args: []
    result: import('./main-window.ts').BrowserPaneSession | null
  }
  'main-window:set-browser-session': {
    args: [session: import('./main-window.ts').BrowserPaneSession]
    result: undefined
  }

  // File system
  'fs:read-file': { args: [projectId: string, threadId: string, path: string]; result: string }
  'fs:write-file': {
    args: [projectId: string, threadId: string, path: string, content: string]
    result: undefined
  }
  'fs:readdir': { args: [projectId: string, threadId: string, path: string]; result: string[] }
  'fs:list-dir': {
    args: [projectId: string, threadId: string, path: string]
    result: { name: string; isDir: boolean }[]
  }
  'fs:watch': { args: [projectId: string, threadId: string, path: string]; result: undefined }
  'fs:unwatch': { args: [projectId: string, threadId: string, path: string]; result: undefined }

  // Agent
  'agent:run': {
    args: [projectId: string, threadId: string, prompt: string]
    result: undefined
  }
  'agent:describe-images': {
    args: [projectId: string, threadId: string, model: string, userPrompt: string, images: string[]]
    result: { text: string }
  }
  'agent:prepare-checkout': {
    args: [
      projectId: string,
      threadId: string,
      prompt: string,
      choice: import('./worktree.ts').ThreadWorktreeChoice,
      model?: string,
      baseBranch?: string,
    ]
    result: import('./worktree.ts').PreparedThreadCheckout
  }
  'agent:preview-checkout': {
    args: [projectId: string, choice: import('./worktree.ts').ThreadWorktreeChoice, model?: string]
    result: import('./worktree.ts').ThreadCheckoutPreview
  }
  'agent:abort': { args: [threadId: string]; result: undefined }
  'agent:estimate-context': {
    args: [projectId: string, threadId: string, payloadJson: string]
    result: import('./thread.ts').ContextBreakdown
  }
  'agent:clear-history': { args: [projectId: string, threadId: string]; result: undefined }
  'agent:refresh-model-context': { args: []; result: undefined }
  'agent:comparison-models': {
    args: [payload: string]
    result: { a: string; b: string; judge: string }
  }
  'agent:suggest-title': { args: [text: string]; result: string | null }
  'agent:suggest-terminal-title': { args: [text: string]; result: string | null }
  'agent:suggest-follow-ups': {
    args: [projectId: string, threadId: string, contextJson: string]
    result: import('@shared/follow-ups/types.ts').FollowUpSuggestion[]
  }
  // The composer's Tab-completable next step (experimental, off by default).
  // Same context shape as suggestFollowUps; null means "no obvious next step",
  // which is the expected answer for most turns.
  'agent:suggest-next-step': { args: [contextJson: string]; result: string | null }

  // Explicit high-risk, session-only shell mode (issue #1249).
  'security:get-guarded-yolo': {
    args: [threadId: string]
    result: import('./guarded-yolo.ts').GuardedYoloState
  }
  'security:enable-guarded-yolo': {
    args: [threadId: string]
    result: import('./guarded-yolo.ts').GuardedYoloState
  }
  'security:disable-guarded-yolo': {
    args: [threadId: string]
    result: import('./guarded-yolo.ts').GuardedYoloState
  }

  // Unattended container runs (docs/plans/thread-in-container.md).
  'container:run-thread': {
    args: [request: import('./container-run.ts').ContainerRunRequest]
    result: import('./container-run.ts').ContainerRunProgress
  }
  'container:get-run': {
    args: [threadId: string]
    result: import('./container-run.ts').ContainerRunProgress | null
  }

  // Diff approval
  'diff:approve': {
    args: [projectId: string, threadId: string, path: string]
    result: undefined
  }
  'diff:reject': {
    args: [projectId: string, threadId: string, path: string]
    result: undefined
  }
  'diff:approve-all': { args: [projectId: string, threadId: string]; result: undefined }
  'diff:reject-all': { args: [projectId: string, threadId: string]; result: undefined }
  'diff:queue': {
    args: [projectId: string, threadId: string]
    result: { path: string; language: string }[]
  }

  // Approval gate (shell / MCP)
  'approval:respond': {
    args: [
      id: string,
      approved: boolean,
      remember?: boolean,
      comparisonModels?: { a: string; b: string; judge: string },
      grantScope?: 'once' | 'turn-tree',
    ]
    result: undefined
  }

  // ask_user tool — the renderer returns one answer per question, in order.
  'ask:respond': {
    args: [id: string, answers: string[]]
    result: undefined
  }
  'alerts:thread-finished': {
    args: [threadId: string, title: string]
    result: undefined
  }

  // MCP servers
  'mcp:list': { args: []; result: McpServerStatus[] }
  'mcp:reload': { args: []; result: McpServerStatus[] }
  'mcp:set-enabled': { args: [name: string, enabled: boolean]; result: McpServerStatus[] }
  'mcp:list-curated': { args: []; result: CuratedMcpServerStatus[] }
  'mcp:set-curated-enabled': {
    args: [name: string, enabled: boolean]
    result: CuratedMcpServerStatus[]
  }

  // Settings
  'settings:get': { args: [key: string]; result: unknown }
  'settings:set': { args: [key: string, value: unknown]; result: undefined }
  'settings:set-security': {
    args: [
      prefs: {
        localServerUrl: string
        safetyClassifierEnabled: boolean
        safetyExternalDenyThreshold: number
        safetyModel: string
        autoRunSandboxCommands: boolean
        shellAutoApprovalLevel?: AutoApprovalLevel
        mcpAutoAllowReadOnly: boolean
        defaultReadonlyMode: boolean
        webAllowedOrigins: string[]
        webAllowUserApproval: boolean
        approvedProviderHosts?: string[]
        providerAllowUserApproval?: boolean
      },
    ]
    result: undefined
  }
  'settings:get-key': { args: [provider: Provider]; result: boolean }
  // At-rest state for a stored key: true = OS-encrypted, false = base64 plaintext
  // (secure-storage fallback), null = no key stored.
  'settings:get-key-encrypted': { args: [provider: Provider]; result: boolean | null }
  // Persist a key. When OS secure storage is unavailable, plaintext writes also
  // require COPSE_ALLOW_PLAINTEXT_SECRETS=1. With that process opt-in, the caller
  // must still pass `{ allowPlaintext: true }` after explicit per-save consent.
  'settings:set-key': {
    args: [provider: Provider, key: string, opts?: { allowPlaintext?: boolean }]
    result:
      | { ok: true }
      | {
          ok: false
          reason: 'plaintext-storage-disabled' | 'plaintext-consent-required'
        }
  }
  'settings:refresh-hugging-face-models': {
    args: [key?: string]
    result: { ok: boolean; count: number; error?: string }
  }
  'settings:available-providers': {
    args: []
    result: AvailableProviders
  }
  'settings:validate-key': {
    /**
     * An empty `key` means "test the key this provider would actually use" —
     * the stored one, or its env-var fallback. Settings needs that because the
     * key input is write-only: a saved key is never read back into the field,
     * so with no empty-key form the Test button could only ever check a key
     * being typed, never the one in use. The secret stays in the main process.
     */
    args: [provider: CloudProvider, key: string]
    result: { ok: boolean; error?: string; formatOk?: boolean }
  }
  // Opt-in environment scan for provider API keys. Scan returns masked previews
  // (never raw secrets); import populates Settings for any not-yet-configured key.
  'settings:scan-env-keys': {
    args: []
    result: {
      provider: string
      envVar: string
      source: string
      masked: string
      alreadyConfigured: boolean
    }[]
  }
  'settings:import-env-keys': {
    args: [providers?: string[]]
    result: {
      imported: { provider: string; source: string }[]
      skipped: { provider: string; reason: string }[]
    }
  }

  // App icon
  'app-icon:apply': { args: []; result: undefined }

  // Usage ledger
  'usage:get-summary': { args: []; result: import('@shared/usage/aggregate-usage.ts').UsageSummary }
  'usage:get-plan-usage': {
    args: []
    result: import('@copse/plan-usage').PlanUsageSnapshot
  }
  'usage:get-plan-worth-it': {
    args: []
    result: import('@shared/usage/plan-worth-it.ts').PlanWorthItPayload
  }
  // First card URL that resolves for each model id, or null. Probe-cached in
  // the main process, so repeat calls are usually free.
  'model-cards:resolve': {
    args: [modelIds: string[]]
    result: Record<string, import('@copse/llm/model-card-candidates.ts').ModelCardCandidate | null>
  }
  'usage:set-claude-plan-monthly-fee': {
    args: [fee: number | null]
    result: import('@shared/usage/plan-worth-it.ts').PlanWorthItPayload
  }

  // Storage (generic electron-store access)
  'storage:get': { args: [key: string]; result: unknown }
  'storage:set': { args: [key: string, value: unknown]; result: undefined }

  // Filesystem-native thread store (issue #644): one directory per thread under
  // ~/.copse/workspace/<projectId>/<threadId>/. The renderer maps store events
  // onto event-level writes instead of rewriting whole threads.
  'threads:load-project': {
    args: [projectId: string]
    result: import('./thread.ts').Thread[]
  }
  'threads:create': {
    args: [projectId: string, thread: import('./thread.ts').Thread]
    result: undefined
  }
  'threads:append-message': {
    args: [projectId: string, threadId: string, message: import('./thread.ts').Message]
    result: undefined
  }
  'threads:update-meta': {
    args: [
      projectId: string,
      threadId: string,
      patch: Partial<Omit<import('./thread.ts').Thread, 'messages'>>,
    ]
    result: undefined
  }
  'threads:delete': {
    args: [projectId: string, threadId: string]
    result: undefined
  }
  'threads:catalog': {
    args: [projectId: string, query?: string]
    result: import('./thread.ts').ThreadCatalogHit[]
  }
  'threads:list-orphans': {
    args: []
    result: import('./state.ts').OrphanProjectStore[]
  }

  // Worktree management (Settings → Sources → Worktrees). Sizing is separate
  // from listing because it walks the whole checkout; removal is the only
  // mutating call and is confirmed in the renderer first.
  'worktrees:list': {
    args: [projectId: string]
    result: import('./worktree.ts').WorktreeInventoryEntry[]
  }
  'worktrees:size': {
    args: [projectId: string, path: string]
    result: import('./worktree.ts').WorktreeSizeResult
  }
  'worktrees:remove': {
    args: [projectId: string, path: string, force: boolean]
    result: import('./worktree.ts').WorktreeRemovalResult
  }

  // Project-scoped automations (copse.automations plugin).
  'automations:list': {
    args: [projectId: string]
    result: import('./automations.ts').AutomationSchedule[]
  }
  'automations:upsert': {
    args: [projectId: string, input: import('./automations.ts').AutomationScheduleInput]
    result: import('./automations.ts').AutomationSchedule
  }
  'automations:remove': {
    args: [projectId: string, scheduleId: string]
    result: undefined
  }
  'automations:run-now': {
    args: [projectId: string, scheduleId: string]
    result: import('./automations.ts').AutomationTriggerEvent
  }

  // Index
  'index:query': { args: [pattern: string]; result: string[] }
  'index:status': { args: []; result: import('./index-status.ts').WorkspaceIndexStatus }
  'index:resolve-file-references': {
    args: [candidates: string[]]
    result: { candidate: string; path: string; kind: 'file' | 'directory' }[]
  }

  // Terminal
  'terminal:create': {
    args: [
      cols: number,
      rows: number,
      meta: { label?: string; projectId: string; threadId: string | null },
    ]
    result: { sessionId: string; checkoutMode: 'shared' | 'worktree' }
  }
  'terminal:write': { args: [sessionId: string, data: string]; result: undefined }
  'terminal:resize': { args: [sessionId: string, cols: number, rows: number]; result: undefined }
  'terminal:destroy': { args: [sessionId: string]; result: undefined }
  'terminal:set-meta': {
    args: [sessionId: string, meta: { label?: string; threadId?: string | null }]
    result: undefined
  }
  'terminal:set-active': { args: [sessionId: string]; result: undefined }

  // Git
  'git:status': { args: [projectId: string, threadId: string]; result: GitStatusResult | null }
  'git:file-diff': {
    args: [projectId: string, threadId: string, path: string, staged: boolean]
    result: GitFileDiff | null
  }
  'git:is-available': { args: [projectId: string, threadId: string]; result: boolean }
  'git:branch-status': {
    args: [projectId: string, threadId: string, forBranch?: string]
    result: GitBranchStatus
  }
  'git:prompt-state': {
    args: [projectId: string, threadId: string]
    result: GitPromptState
  }
  'git:checkout-branch': {
    args: [projectId: string, threadId: string, branch: string]
    result: undefined
  }

  // GitHub CLI / pull requests
  'gh:status': { args: []; result: import('./git.ts').GhCliStatus }
  'gh:invalidate-read-cache': { args: []; result: undefined }
  'gh:set-list-watch': { args: [watching: boolean, includeMyPrs: boolean]; result: undefined }
  'gh:list-my-open-prs': { args: []; result: import('./git.ts').GhPrSummary[] | null }
  'gh:list-workspace-open-prs': { args: []; result: import('./git.ts').GhPrSummary[] }
  'gh:pr-checks': {
    args: [owner: string, repo: string, number: number]
    result: import('./git.ts').GhPrChecksState
  }
  'gh:pr-details': {
    args: [owner: string, repo: string, number: number]
    result: import('./git.ts').GhPrDetails | null
  }
  'gh:pr-file-diff': {
    args: [owner: string, repo: string, number: number, path: string]
    result: import('./git.ts').GhPrFileDiff | null
  }
  'gh:resolve-pr-url': {
    args: [url: string]
    result: { owner: string; repo: string; number: number } | null
  }

  // Remote agent artifacts
  'remote-agent:download-artifact': { args: [agentId: string, path: string]; result: string }
  'remote-agent:artifact-image-data-url': { args: [agentId: string, path: string]; result: string }

  // Shell
  'shell:open-external': { args: [url: string]; result: undefined }
  'shell:open-workspace-file-in-browser': {
    args: [projectId: string, threadId: string, path: string]
    result: undefined
  }
  'browser:workspace-file-url': {
    args: [projectId: string, threadId: string, path: string]
    result: string
  }

  // External editors ("Open in …" titlebar dropdown)
  'editors:list': { args: []; result: import('./editors.ts').ExternalEditorList }
  'editors:open': {
    args: [projectId: string, threadId: string, editorId: string]
    result: undefined
  }

  // LM Studio
  'lm-studio:test': {
    args: [url: string, apiKey?: string]
    result: { ok: boolean; models?: string[]; error?: string }
  }
  'lm-studio:models': { args: []; result: string[] }
  'lm-studio:model-info': {
    args: []
    result: Array<{ id: string; supportsImages?: boolean }>
  }
  'open-router:models': {
    args: []
    result: Array<{
      id: string
      name: string
      inputPricePerMTok: number | null
      outputPricePerMTok: number | null
      supportsImages?: boolean
    }>
  }
  'lm-studio:detect': {
    args: [url?: string, apiKey?: string]
    result: {
      serverRunning: boolean
      serverUrl: string
      installDetected: boolean
      models: string[]
      modelContexts: Record<string, number>
      preferredPresent: string[]
      preferredMissing: string[]
      error?: string
    }
  }
  'lm-studio:download': {
    args: [modelId: string, url?: string, apiKey?: string]
    result: {
      ok: boolean
      jobId?: string
      status?: string
      totalSizeBytes?: number
      error?: string
    }
  }
  'lm-studio:download-status': {
    args: [jobId: string, url?: string, apiKey?: string]
    result: {
      ok: boolean
      jobId: string
      status?: string
      totalSizeBytes?: number
      downloadedBytes?: number
      error?: string
    }
  }
}

// event channels (main → renderer, fire-and-forget)
export interface IpcEventMap {
  'workspace:opened': [root: string]
  'agent:chunk': [threadId: string, chunk: StreamChunk]
  'agent:show-diff': [
    projectId: string,
    threadId: string,
    path: string,
    before: string,
    after: string,
    language: string,
  ]
  'agent:shell-output': [data: string, toolCallId: string | null]
  'agent:approval-request': [
    {
      id: string
      /** Thread whose run triggered this request; scopes the prompt in the UI. */
      threadId?: string
      title: string
      body: string
      type: 'shell' | 'mcp' | 'web' | 'pii' | 'model-compare' | 'review-spend'
      allowRemember?: boolean
      rememberLabel?: string
      showWhileSettingsOpen?: boolean
      comparisonModels?: { a: string; b: string; judge: string }
      allowTurnTreeLease?: boolean
      turnTreeLeaseLabel?: string
      turnTreeLeaseDefault?: boolean
      turnTreeLeaseSubject?: string
    },
  ]
  /** Main dismisses an approval the run cancelled (Stop / ACP permission RPC abort). */
  'agent:approval-cancelled': [{ id: string }]
  'agent:ask-user-request': [
    {
      id: string
      /** Thread whose run asked the question; scopes the prompt in the UI. */
      threadId?: string
      questions: { question: string; options?: string[] }[]
    },
  ]
  /** Main dismisses an ask_user request when its run stops or the request expires. */
  'agent:ask-user-cancelled': [{ id: string }]
  'agent:hook-queue-message': [payload: import('./hooks.ts').HookQueueMessagePayload]
  'security:guarded-yolo-changed': [state: import('./guarded-yolo.ts').GuardedYoloState]
  'container:run-changed': [progress: import('./container-run.ts').ContainerRunProgress]
  'automations:triggered': [event: import('./automations.ts').AutomationTriggerEvent]
  'ssh:prompt-request': [
    {
      id: string
      prompt: string
      kind: 'confirm' | 'secret'
      canRememberOnDevice: boolean
    },
  ]
  'update:prompt-request': [
    {
      id: string
      message: string
      detail?: string
      buttons: string[]
      defaultIndex?: number
      cancelIndex?: number
    },
  ]
  'update:dev-notice': []
  /** Main asks the renderer whether the app may close while threads are working. */
  'app:close-confirm-request': [{ id: string }]
  'ssh:connection-changed': [states: import('./ssh-workspace.ts').SshConnectionState[]]
  'mcp:status-changed': [statuses: McpServerStatus[]]
  'index:status-changed': [status: import('./index-status.ts').WorkspaceIndexStatus]
  'diff:queued': [
    projectId: string,
    threadId: string,
    entries: { path: string; language: string }[],
  ]
  'diff:conflict': [projectId: string, threadId: string, paths: string[]]
  'fs:changed': [projectId: string, threadId: string, path: string, content: string | null]
  /** A recursive local execution-root watcher observed a possible git change. */
  'git:working-tree-changed': [root: string]
  'menu:settings': []
  'menu:new-thread': []
  'menu:toggle-panel': []
  'menu:show-explorer': []
  'menu:show-terminal': []
  'menu:show-changes': []
  'menu:show-browser': []
  'menu:ui-scale-zoom-in': []
  'menu:ui-scale-zoom-out': []
  'menu:ui-scale-reset': []
  'terminal:output': [sessionId: string, data: string]
  'terminal:exit': [sessionId: string, code: number]
  /** Open a fresh shell in the Shells pane already running this command. */
  'terminal:run-command': [command: string]
  /**
   * Shared PR-list poll tick. One main-process timer for every window showing
   * the pane; renderers no-op unless that window is actually on PRs.
   */
  'gh:lists-tick': []
}
