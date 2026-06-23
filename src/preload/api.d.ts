import type { StreamChunk, UsageDelta, ContextBreakdown } from '@shared/types'
import type { SkillSummary } from '@shared/types/skills.ts'
import type { CursorPluginSummary } from '@shared/types/cursor-plugins.ts'
import type { CursorHookSummary } from '@shared/types/cursor-hooks.ts'
import type { GitFileDiff, GitStatusResult, GitBranchStatus } from '@shared/types/git.ts'
import type { McpServerStatus } from '@shared/types/mcp.ts'
import type { FollowUpSuggestion } from '@shared/follow-ups/types.ts'

export interface ApiClient {
  workspace: {
    open: () => Promise<string | null>
    get: () => Promise<string | null>
    set: (root: string) => Promise<string>
    isTrusted: () => Promise<boolean>
    setTrusted: (trusted: boolean) => Promise<McpServerStatus[]>
    onOpened: (handler: (root: string) => void) => () => void
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
    clearHistory: (threadId: string) => Promise<void>
    suggestTitle: (text: string) => Promise<string | null>
    suggestTerminalTitle: (text: string) => Promise<string | null>
    suggestFollowUps: (contextJson: string) => Promise<FollowUpSuggestion[]>
    onChunk: (handler: (threadId: string, chunk: StreamChunk) => void) => () => void
    onApprovalRequest: (
      handler: (req: {
        id: string
        title: string
        body: string
        type: string
        allowRemember?: boolean
        rememberLabel?: string
      }) => void,
    ) => () => void
    onShellOutput: (handler: (data: string) => void) => () => void
    onUsage: (handler: (threadId: string, usage: UsageDelta) => void) => () => void
  }
  diff: {
    approve: (path: string) => Promise<void>
    reject: (path: string) => Promise<void>
    approveAll: () => Promise<void>
    rejectAll: () => Promise<void>
    onShowDiff: (
      handler: (path: string, before: string, after: string, lang: string) => void,
    ) => () => void
    onQueued: (handler: (entries: { path: string; language: string }[]) => void) => () => void
    onConflict: (handler: (paths: string[]) => void) => () => void
  }
  approval: {
    respond: (id: string, approved: boolean, remember?: boolean) => Promise<void>
  }
  mcp: {
    list: () => Promise<McpServerStatus[]>
    reload: () => Promise<McpServerStatus[]>
    setEnabled: (name: string, enabled: boolean) => Promise<McpServerStatus[]>
    onStatusChanged: (handler: (statuses: McpServerStatus[]) => void) => () => void
  }
  storage: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
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
  menu: {
    onSettings: (handler: () => void) => () => void
    onTogglePanel: (handler: () => void) => () => void
    onShowExplorer: (handler: () => void) => () => void
    onShowTerminal: (handler: () => void) => () => void
    onShowChanges: (handler: () => void) => () => void
    onShowBrowser: (handler: () => void) => () => void
  }
  settings: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    setSecurity: (prefs: {
      localServerUrl: string
      safetyClassifierEnabled: boolean
      safetyConfidenceThreshold: number
      safetyModel: string
      autoRunSandboxCommands: boolean
      mcpAutoAllowReadOnly: boolean
      webAllowedOrigins: string[]
      webAllowUserApproval: boolean
    }) => Promise<void>
    getKey: (provider: 'anthropic' | 'openai' | 'lmstudio') => Promise<boolean>
    setKey: (provider: 'anthropic' | 'openai' | 'lmstudio', key: string) => Promise<void>
    availableProviders: () => Promise<{ anthropic: boolean; openai: boolean }>
    validateKey: (
      provider: 'anthropic' | 'openai',
      key: string,
    ) => Promise<{ ok: boolean; error?: string; formatOk?: boolean }>
  }
  appIcon: {
    apply: () => Promise<void>
  }
  index: {
    query: (pattern: string) => Promise<string[]>
    resolveFileReferences: (candidates: string[]) => Promise<{ candidate: string; path: string }[]>
  }
  skills: {
    list: () => Promise<SkillSummary[]>
  }
  plugins: {
    list: () => Promise<CursorPluginSummary[]>
  }
  hooks: {
    list: () => Promise<CursorHookSummary[]>
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
    fileDiff: (path: string, staged: boolean) => Promise<GitFileDiff | null>
    branchStatus: (forBranch?: string) => Promise<GitBranchStatus>
    checkoutBranch: (branch: string) => Promise<void>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
  }
}

declare global {
  interface Window {
    api: ApiClient
  }
}
