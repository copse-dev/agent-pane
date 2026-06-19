import type { StreamChunk } from '@shared/types'

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
    suggestTitle: (text: string) => Promise<string | null>
    onChunk: (handler: (threadId: string, chunk: StreamChunk) => void) => () => void
    onApprovalRequest: (
      handler: (req: { id: string; title: string; body: string; type: string }) => void,
    ) => () => void
    onShellOutput: (handler: (data: string) => void) => () => void
    onUsage: (
      handler: (threadId: string, usage: { inputTokens: number; outputTokens: number }) => void,
    ) => () => void
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
    respond: (id: string, approved: boolean) => Promise<void>
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
  index: {
    query: (pattern: string) => Promise<string[]>
  }
}

declare global {
  interface Window {
    api: ApiClient
  }
}
