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
  'fs:writeFile': { args: [path: string, content: string]; result: void }
  'fs:readdir': { args: [path: string]; result: string[] }
  'fs:listDir': { args: [path: string]; result: { name: string; isDir: boolean }[] }
  'fs:watch': { args: [path: string]; result: void }
  'fs:unwatch': { args: [path: string]; result: void }

  // Agent
  'agent:run': { args: [threadId: string, prompt: string]; result: void }
  'agent:abort': { args: [threadId: string]; result: void }
  'agent:clearHistory': { args: [threadId: string]; result: void }
  'agent:refreshModelContext': { args: []; result: void }
  'agent:suggestTitle': { args: [text: string]; result: string | null }
  'agent:suggestTerminalTitle': { args: [text: string]; result: string | null }
  'agent:suggestFollowUps': {
    args: [contextJson: string]
    result: import('@shared/follow-ups/types.ts').FollowUpSuggestion[]
  }

  // Diff approval
  'diff:approve': { args: [path: string]; result: void }
  'diff:reject': { args: [path: string]; result: void }
  'diff:approveAll': { args: []; result: void }
  'diff:rejectAll': { args: []; result: void }

  // Approval gate (shell / MCP)
  'approval:respond': { args: [id: string, approved: boolean, remember?: boolean]; result: void }

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
  'settings:set': { args: [key: string, value: unknown]; result: void }
  'settings:setSecurity': {
    args: [
      prefs: {
        localServerUrl: string
        safetyClassifierEnabled: boolean
        safetyConfidenceThreshold: number
        safetyModel: string
        autoRunSandboxCommands: boolean
        mcpAutoAllowReadOnly: boolean
        defaultReadonlyMode: boolean
        webAllowedOrigins: string[]
        webAllowUserApproval: boolean
      },
    ]
    result: void
  }
  'settings:getKey': { args: [provider: Provider]; result: boolean }
  'settings:setKey': { args: [provider: Provider, key: string]; result: void }
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

  // App icon
  'app-icon:apply': { args: []; result: void }

  // Usage ledger
  'usage:record': {
    args: [input: import('@shared/usage/usage-event.ts').UsageRecordInput]
    result: void
  }
  'usage:getSummary': { args: []; result: import('@shared/usage/aggregate-usage.ts').UsageSummary }

  // Storage (generic electron-store access)
  'storage:get': { args: [key: string]; result: unknown }
  'storage:set': { args: [key: string, value: unknown]; result: void }

  // Index
  'index:query': { args: [pattern: string]; result: string[] }

  // Terminal
  'terminal:create': { args: [cols: number, rows: number]; result: string }
  'terminal:write': { args: [sessionId: string, data: string]; result: void }
  'terminal:resize': { args: [sessionId: string, cols: number, rows: number]; result: void }
  'terminal:destroy': { args: [sessionId: string]; result: void }

  // Git
  'git:status': { args: []; result: GitStatusResult | null }
  'git:fileDiff': { args: [path: string, staged: boolean]; result: GitFileDiff | null }
  'git:isAvailable': { args: []; result: boolean }
  'git:branchStatus': { args: [forBranch?: string]; result: GitBranchStatus }
  'git:checkoutBranch': { args: [branch: string]; result: void }

  // GitHub CLI / pull requests
  'gh:status': { args: []; result: import('./git.ts').GhCliStatus }
  'gh:listMyOpenPrs': { args: []; result: import('./git.ts').GhPrSummary[] | null }
  'gh:listWorkspaceOpenPrs': { args: []; result: import('./git.ts').GhPrSummary[] }
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
  'shell:openExternal': { args: [url: string]; result: void }

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
  'agent:shell_output': [data: string]
  'agent:approval_request': [
    {
      id: string
      title: string
      body: string
      type: 'shell' | 'mcp' | 'web'
      allowRemember?: boolean
      rememberLabel?: string
    },
  ]
  'mcp:status_changed': [statuses: McpServerStatus[]]
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
