import type { StreamChunk, UsageDelta } from '@shared/types'
import type { SkillSummary } from '@shared/types/skills.ts'
import type { GitFileDiff, GitStatusResult } from '@shared/types/git.ts'
import type { McpServerStatus } from '@shared/types/mcp.ts'
import type { FollowUpSuggestion } from '@shared/follow-ups/types.ts'

export interface ApiClient {
  workspace: {
    open: () => Promise<string | null>
    get: () => Promise<string | null>
    set: (root: string) => Promise<string>
    onOpened: (handler: (root: string) => void) => () => void
  }
  fs: {
    readFile: (path: string) => Promise<string>
    writeFile: (path: string, content: string) => Promise<void>
    readdir: (path: string) => Promise<string[]>
    listDir: (path: string) => Promise<{ name: string; isDir: boolean }[]>
    watch: (path: string) => Promise<void>
    unwatch: (path: string) => Promise<void>
    onChanged: (handler: (path: string, content: string) => void) => () => void
  }
  agent: {
    run: (threadId: string, prompt: string) => Promise<void>
    abort: (threadId: string) => Promise<void>
    clearHistory: (threadId: string) => Promise<void>
    suggestTitle: (text: string) => Promise<string | null>
    suggestFollowUps: (contextJson: string) => Promise<FollowUpSuggestion[]>
    onChunk: (handler: (threadId: string, chunk: StreamChunk) => void) => () => void
    onApprovalRequest: (
      handler: (req: {
        id: string
        title: string
        body: string
        type: string
        allowRemember?: boolean
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
  }
  menu: {
    onSettings: (handler: () => void) => () => void
  }
  settings: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    getKey: (provider: 'anthropic' | 'openai' | 'lmstudio') => Promise<boolean>
    setKey: (provider: 'anthropic' | 'openai' | 'lmstudio', key: string) => Promise<void>
    availableProviders: () => Promise<{ anthropic: boolean; openai: boolean }>
  }
  appIcon: {
    apply: () => Promise<void>
  }
  index: {
    query: (pattern: string) => Promise<string[]>
  }
  skills: {
    list: () => Promise<SkillSummary[]>
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
  }
}

declare global {
  interface Window {
    api: ApiClient
  }
}
