import type { StreamChunk } from './stream.ts'
import type { GitFileDiff, GitStatusResult, GitBranchStatus } from './git.ts'
import type { McpServerStatus, CuratedMcpServerStatus } from './mcp.ts'
import type { UsageDelta } from './thread.ts'

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
  'workspace:set': { args: [root: string]; result: string }

  // File system
  'fs:readFile': { args: [path: string]; result: string }
  'fs:writeFile': { args: [path: string, content: string]; result: undefined }
  'fs:readdir': { args: [path: string]; result: string[] }
  'fs:listDir': { args: [path: string]; result: { name: string; isDir: boolean }[] }
  'fs:watch': { args: [path: string]; result: undefined }
  'fs:unwatch': { args: [path: string]; result: undefined }

  // Agent
  'agent:run': { args: [threadId: string, prompt: string]; result: undefined }
  'agent:abort': { args: [threadId: string]; result: undefined }
  'agent:clearHistory': { args: [threadId: string]; result: undefined }
  'agent:refreshModelContext': { args: []; result: undefined }
  'agent:suggestTitle': { args: [text: string]; result: string | null }
  'agent:suggestTerminalTitle': { args: [text: string]; result: string | null }
  'agent:suggestFollowUps': {
    args: [contextJson: string]
    result: import('@shared/follow-ups/types.ts').FollowUpSuggestion[]
  }

  // Diff approval
  'diff:approve': { args: [path: string]; result: undefined }
  'diff:reject': { args: [path: string]; result: undefined }
  'diff:approveAll': { args: []; result: undefined }
  'diff:rejectAll': { args: []; result: undefined }

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
        mcpAutoAllowReadOnly: boolean
        defaultReadonlyMode: boolean
        webAllowedOrigins: string[]
        webAllowUserApproval: boolean
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

  // Index
  'index:query': { args: [pattern: string]; result: string[] }
  'index:status': { args: []; result: import('./index-status.ts').WorkspaceIndexStatus }
  'index:resolveFileReferences': {
    args: [candidates: string[]]
    result: { candidate: string; path: string; kind: 'file' | 'directory' }[]
  }

  // Terminal
  'terminal:create': { args: [cols: number, rows: number]; result: string }
  'terminal:write': { args: [sessionId: string, data: string]; result: undefined }
  'terminal:resize': { args: [sessionId: string, cols: number, rows: number]; result: undefined }
  'terminal:destroy': { args: [sessionId: string]; result: undefined }

  // Git
  'git:status': { args: []; result: GitStatusResult | null }
  'git:fileDiff': { args: [path: string, staged: boolean]; result: GitFileDiff | null }
  'git:isAvailable': { args: []; result: boolean }
  'git:branchStatus': { args: [forBranch?: string]; result: GitBranchStatus }
  'git:checkoutBranch': { args: [branch: string]; result: undefined }

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
  'editors:open': { args: [editorId: string]; result: undefined }

  // LM Studio
  'lmstudio:test': {
    args: [url: string, apiKey?: string]
    result: { ok: boolean; models?: string[]; error?: string }
  }
  'lmstudio:models': { args: []; result: string[] }
  'openrouter:models': { args: []; result: Array<{ id: string; name: string }> }
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
  'agent:usage': [threadId: string, usage: UsageDelta]
  'agent:show_diff': [path: string, before: string, after: string, language: string]
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
      comparisonModels?: { a: string; b: string; judge: string }
    },
  ]
  'agent:ask_user_request': [
    {
      id: string
      /** Thread whose run asked the question; scopes the prompt in the UI. */
      threadId?: string
      questions: { question: string; options?: string[] }[]
    },
  ]
  'ssh:prompt_request': [
    {
      id: string
      prompt: string
      kind: 'confirm' | 'secret'
    },
  ]
  'ssh:connection_changed': [states: import('./ssh-workspace.ts').SshConnectionState[]]
  'mcp:status_changed': [statuses: McpServerStatus[]]
  'index:status_changed': [status: import('./index-status.ts').WorkspaceIndexStatus]
  'diff:queued': [entries: { path: string; language: string }[]]
  'diff:conflict': [paths: string[]]
  'fs:changed': [path: string, content: string | null]
  'menu:settings': []
  'menu:newThread': []
  'menu:togglePanel': []
  'menu:showExplorer': []
  'menu:showTerminal': []
  'menu:showChanges': []
  'menu:showBrowser': []
  'theme:changed': ['light' | 'dark']
  'terminal:output': [sessionId: string, data: string]
  'terminal:exit': [sessionId: string, code: number]
}
