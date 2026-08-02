import type { AutoApprovalLevel } from '../auto-approval.ts'
import type { StreamChunk } from './stream.ts'
import type { GitFileDiff, GitStatusResult, GitBranchStatus } from './git.ts'
import type { McpServerStatus, CuratedMcpServerStatus } from './mcp.ts'

type Provider =
  'anthropic' | 'openai' | 'lmstudio' | 'cursor' | 'openrouter' | 'mistral' | 'gemini' | 'deepseek'
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

  // File system
  'fs:readFile': { args: [projectId: string, threadId: string, path: string]; result: string }
  'fs:writeFile': {
    args: [projectId: string, threadId: string, path: string, content: string]
    result: undefined
  }
  'fs:readdir': { args: [projectId: string, threadId: string, path: string]; result: string[] }
  'fs:listDir': {
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
  'agent:prepareCheckout': {
    args: [
      projectId: string,
      threadId: string,
      prompt: string,
      choice: import('./worktree.ts').ThreadWorktreeChoice,
      model?: string,
    ]
    result: import('./worktree.ts').PreparedThreadCheckout
  }
  'agent:previewCheckout': {
    args: [projectId: string, choice: import('./worktree.ts').ThreadWorktreeChoice, model?: string]
    result: import('./worktree.ts').ThreadCheckoutPreview
  }
  'agent:abort': { args: [threadId: string]; result: undefined }
  'agent:estimateContext': {
    args: [projectId: string, threadId: string, payloadJson: string]
    result: import('./thread.ts').ContextBreakdown
  }
  'agent:clearHistory': { args: [projectId: string, threadId: string]; result: undefined }
  'agent:refreshModelContext': { args: []; result: undefined }
  'agent:suggestTitle': { args: [text: string]; result: string | null }
  'agent:suggestTerminalTitle': { args: [text: string]; result: string | null }
  'agent:suggestFollowUps': {
    args: [contextJson: string]
    result: import('@shared/follow-ups/types.ts').FollowUpSuggestion[]
  }

  // Explicit high-risk, session-only shell mode (issue #1249).
  'security:getGuardedYolo': {
    args: [threadId: string]
    result: import('./guarded-yolo.ts').GuardedYoloState
  }
  'security:enableGuardedYolo': {
    args: [threadId: string]
    result: import('./guarded-yolo.ts').GuardedYoloState
  }
  'security:disableGuardedYolo': {
    args: [threadId: string]
    result: import('./guarded-yolo.ts').GuardedYoloState
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
  'diff:approveAll': { args: [projectId: string, threadId: string]; result: undefined }
  'diff:rejectAll': { args: [projectId: string, threadId: string]; result: undefined }

  // Approval gate (shell / MCP)
  'approval:respond': {
    args: [
      id: string,
      approved: boolean,
      remember?: boolean,
      comparisonModels?: { a: string; b: string; judge: string },
    ]
    result: undefined
  }

  // ask_user tool — the renderer returns one answer per question, in order.
  'ask:respond': {
    args: [id: string, answers: string[]]
    result: undefined
  }

  // MCP servers
  'mcp:list': { args: []; result: McpServerStatus[] }
  'mcp:reload': { args: []; result: McpServerStatus[] }
  'mcp:setEnabled': { args: [name: string, enabled: boolean]; result: McpServerStatus[] }
  'mcp:listCurated': { args: []; result: CuratedMcpServerStatus[] }
  'mcp:setCuratedEnabled': {
    args: [name: string, enabled: boolean]
    result: CuratedMcpServerStatus[]
  }

  // Settings
  'settings:get': { args: [key: string]; result: unknown }
  'settings:set': { args: [key: string, value: unknown]; result: undefined }
  'settings:setSecurity': {
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
  'settings:getKey': { args: [provider: Provider]; result: boolean }
  // At-rest state for a stored key: true = OS-encrypted, false = base64 plaintext
  // (secure-storage fallback), null = no key stored.
  'settings:getKeyEncrypted': { args: [provider: Provider]; result: boolean | null }
  // Persist a key. When OS secure storage is unavailable, the key is only written
  // if the caller passes `{ allowPlaintext: true }` (explicit per-save consent);
  // otherwise nothing is stored and the result reports `plaintext-consent-required`
  // so the renderer can confirm and retry.
  'settings:setKey': {
    args: [provider: Provider, key: string, opts?: { allowPlaintext?: boolean }]
    result: { ok: true } | { ok: false; reason: 'plaintext-consent-required' }
  }
  'settings:refreshHuggingFaceModels': {
    args: [key?: string]
    result: { ok: boolean; count: number; error?: string }
  }
  'settings:availableProviders': {
    args: []
    result: AvailableProviders
  }
  'settings:validateKey': {
    args: [provider: CloudProvider, key: string]
    result: { ok: boolean; error?: string; formatOk?: boolean }
  }
  // Opt-in environment scan for provider API keys. Scan returns masked previews
  // (never raw secrets); import populates Settings for any not-yet-configured key.
  'settings:scanEnvKeys': {
    args: []
    result: {
      provider: string
      envVar: string
      source: string
      masked: string
      alreadyConfigured: boolean
    }[]
  }
  'settings:importEnvKeys': {
    args: []
    result: {
      imported: { provider: string; source: string }[]
      skipped: { provider: string; reason: string }[]
    }
  }

  // App icon
  'app-icon:apply': { args: []; result: undefined }

  // Usage ledger
  'usage:record': {
    args: [input: import('@shared/usage/usage-event.ts').UsageRecordInput]
    result: undefined
  }
  'usage:getSummary': { args: []; result: import('@shared/usage/aggregate-usage.ts').UsageSummary }
  'usage:getPlanUsage': {
    args: []
    result: import('@copse/plan-usage').PlanUsageSnapshot
  }
  'usage:getPlanWorthIt': {
    args: []
    result: import('@shared/usage/plan-worth-it.ts').PlanWorthItPayload
  }
  'usage:setClaudePlanMonthlyFee': {
    args: [fee: number | null]
    result: import('@shared/usage/plan-worth-it.ts').PlanWorthItPayload
  }

  // Storage (generic electron-store access)
  'storage:get': { args: [key: string]; result: unknown }
  'storage:set': { args: [key: string, value: unknown]; result: undefined }

  // Filesystem-native thread store (issue #644): one directory per thread under
  // ~/.copse/workspace/<projectId>/<threadId>/. The renderer maps store events
  // onto event-level writes instead of rewriting whole threads.
  'threads:loadProject': {
    args: [projectId: string]
    result: import('./thread.ts').Thread[]
  }
  'threads:create': {
    args: [projectId: string, thread: import('./thread.ts').Thread]
    result: undefined
  }
  'threads:appendMessage': {
    args: [projectId: string, threadId: string, message: import('./thread.ts').Message]
    result: undefined
  }
  'threads:updateMeta': {
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
  'threads:listOrphans': {
    args: []
    result: import('./state.ts').OrphanProjectStore[]
  }

  // Project-scoped automations (copse.automations pack).
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
  'automations:runNow': {
    args: [projectId: string, scheduleId: string]
    result: import('./automations.ts').AutomationTriggerEvent
  }

  // Index
  'index:query': { args: [pattern: string]; result: string[] }
  'index:status': { args: []; result: import('./index-status.ts').WorkspaceIndexStatus }
  'index:resolveFileReferences': {
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
    result: string
  }
  'terminal:write': { args: [sessionId: string, data: string]; result: undefined }
  'terminal:resize': { args: [sessionId: string, cols: number, rows: number]; result: undefined }
  'terminal:destroy': { args: [sessionId: string]; result: undefined }
  'terminal:setMeta': {
    args: [sessionId: string, meta: { label?: string; threadId?: string | null }]
    result: undefined
  }
  'terminal:setActive': { args: [sessionId: string]; result: undefined }

  // Git
  'git:status': { args: [projectId: string, threadId: string]; result: GitStatusResult | null }
  'git:fileDiff': {
    args: [projectId: string, threadId: string, path: string, staged: boolean]
    result: GitFileDiff | null
  }
  'git:isAvailable': { args: [projectId: string, threadId: string]; result: boolean }
  'git:branchStatus': {
    args: [projectId: string, threadId: string, forBranch?: string]
    result: GitBranchStatus
  }
  'git:checkoutBranch': {
    args: [projectId: string, threadId: string, branch: string]
    result: undefined
  }

  // GitHub CLI / pull requests
  'gh:status': { args: []; result: import('./git.ts').GhCliStatus }
  'gh:listMyOpenPrs': { args: []; result: import('./git.ts').GhPrSummary[] | null }
  'gh:listWorkspaceOpenPrs': { args: []; result: import('./git.ts').GhPrSummary[] }
  'gh:prChecks': {
    args: [owner: string, repo: string, number: number]
    result: import('./git.ts').GhPrChecksState
  }
  'gh:prDetails': {
    args: [owner: string, repo: string, number: number]
    result: import('./git.ts').GhPrDetails | null
  }
  'gh:prFileDiff': {
    args: [owner: string, repo: string, number: number, path: string]
    result: import('./git.ts').GhPrFileDiff | null
  }
  'gh:resolvePrUrl': {
    args: [url: string]
    result: { owner: string; repo: string; number: number } | null
  }

  // Remote agent artifacts
  'remoteAgent:downloadArtifact': { args: [agentId: string, path: string]; result: string }
  'remoteAgent:artifactImageDataUrl': { args: [agentId: string, path: string]; result: string }

  // Shell
  'shell:openExternal': { args: [url: string]; result: undefined }

  // External editors ("Open in …" titlebar dropdown)
  'editors:list': { args: []; result: import('./editors.ts').ExternalEditorList }
  'editors:open': {
    args: [projectId: string, threadId: string, editorId: string]
    result: undefined
  }

  // LM Studio
  'lmstudio:test': {
    args: [url: string, apiKey?: string]
    result: { ok: boolean; models?: string[]; error?: string }
  }
  'lmstudio:models': { args: []; result: string[] }
  'openrouter:models': {
    args: []
    result: Array<{
      id: string
      name: string
      inputPricePerMTok: number | null
      outputPricePerMTok: number | null
    }>
  }
  'lmstudio:detect': {
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
  'lmstudio:download': {
    args: [modelId: string, url?: string, apiKey?: string]
    result: {
      ok: boolean
      jobId?: string
      status?: string
      totalSizeBytes?: number
      error?: string
    }
  }
  'lmstudio:downloadStatus': {
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
  'agent:show_diff': [
    projectId: string,
    threadId: string,
    path: string,
    before: string,
    after: string,
    language: string,
  ]
  'agent:shell_output': [data: string, toolCallId: string | null]
  'agent:approval_request': [
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
    },
  ]
  /** Main dismisses an approval the run cancelled (Stop / ACP permission RPC abort). */
  'agent:approval_cancelled': [{ id: string }]
  'agent:ask_user_request': [
    {
      id: string
      /** Thread whose run asked the question; scopes the prompt in the UI. */
      threadId?: string
      questions: { question: string; options?: string[] }[]
    },
  ]
  'agent:hook_queue_message': [payload: import('./hooks.ts').HookQueueMessagePayload]
  'security:guardedYoloChanged': [state: import('./guarded-yolo.ts').GuardedYoloState]
  'automations:triggered': [event: import('./automations.ts').AutomationTriggerEvent]
  'ssh:prompt_request': [
    {
      id: string
      prompt: string
      kind: 'confirm' | 'secret'
    },
  ]
  'update:prompt_request': [
    {
      id: string
      message: string
      detail?: string
      buttons: string[]
      defaultIndex?: number
      cancelIndex?: number
    },
  ]
  'update:dev_notice': []
  'ssh:connection_changed': [states: import('./ssh-workspace.ts').SshConnectionState[]]
  'mcp:status_changed': [statuses: McpServerStatus[]]
  'index:status_changed': [status: import('./index-status.ts').WorkspaceIndexStatus]
  'diff:queued': [
    projectId: string,
    threadId: string,
    entries: { path: string; language: string }[],
  ]
  'diff:conflict': [projectId: string, threadId: string, paths: string[]]
  'fs:changed': [projectId: string, threadId: string, path: string, content: string | null]
  'menu:settings': []
  'menu:newThread': []
  'menu:togglePanel': []
  'menu:showExplorer': []
  'menu:showTerminal': []
  'menu:showChanges': []
  'menu:showBrowser': []
  'menu:uiScaleZoomIn': []
  'menu:uiScaleZoomOut': []
  'menu:uiScaleReset': []
  'theme:changed': ['light' | 'dark']
  'terminal:output': [sessionId: string, data: string]
  'terminal:exit': [sessionId: string, code: number]
  /** Open a fresh shell in the Shells pane already running this command. */
  'terminal:run_command': [command: string]
}
