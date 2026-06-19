import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  workspace: {
    open: () => ipcRenderer.invoke('workspace:open'),
    get: () => ipcRenderer.invoke('workspace:get'),
    set: (root: string) => ipcRenderer.invoke('workspace:set', root),
    onOpened: (handler: (root: string) => void) => {
      ipcRenderer.on('workspace:opened', (_e, root) => handler(root))
      return () => ipcRenderer.removeAllListeners('workspace:opened')
    },
  },
  fs: {
    readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
    writeFile: (path: string, content: string) => ipcRenderer.invoke('fs:writeFile', path, content),
    readdir: (path: string) => ipcRenderer.invoke('fs:readdir', path),
    listDir: (path: string) => ipcRenderer.invoke('fs:listDir', path),
    watch: (path: string) => ipcRenderer.invoke('fs:watch', path),
    unwatch: (path: string) => ipcRenderer.invoke('fs:unwatch', path),
    onChanged: (handler: (path: string, content: string) => void) => {
      ipcRenderer.on('fs:changed', (_e, p, c) => handler(p, c))
      return () => ipcRenderer.removeAllListeners('fs:changed')
    },
  },
  agent: {
    run: (threadId: string, prompt: string) => ipcRenderer.invoke('agent:run', threadId, prompt),
    abort: (threadId: string) => ipcRenderer.invoke('agent:abort', threadId),
    clearHistory: (threadId: string) => ipcRenderer.invoke('agent:clearHistory', threadId),
    suggestTitle: (text: string) => ipcRenderer.invoke('agent:suggestTitle', text),
    onChunk: (handler: (threadId: string, chunk: unknown) => void) => {
      ipcRenderer.on('agent:chunk', (_e, tid, chunk) => handler(tid, chunk))
      return () => ipcRenderer.removeAllListeners('agent:chunk')
    },
    onApprovalRequest: (
      handler: (req: { id: string; title: string; body: string; type: string }) => void,
    ) => {
      ipcRenderer.on('agent:approval_request', (_e, req) => handler(req))
      return () => ipcRenderer.removeAllListeners('agent:approval_request')
    },
    onShellOutput: (handler: (data: string) => void) => {
      ipcRenderer.on('agent:shell_output', (_e, data) => handler(data))
      return () => ipcRenderer.removeAllListeners('agent:shell_output')
    },
    onUsage: (
      handler: (threadId: string, usage: { inputTokens: number; outputTokens: number }) => void,
    ) => {
      ipcRenderer.on('agent:usage', (_e, threadId, usage) => handler(threadId, usage))
      return () => ipcRenderer.removeAllListeners('agent:usage')
    },
  },
  diff: {
    approve: (path: string) => ipcRenderer.invoke('diff:approve', path),
    reject: (path: string) => ipcRenderer.invoke('diff:reject', path),
    approveAll: () => ipcRenderer.invoke('diff:approveAll'),
    rejectAll: () => ipcRenderer.invoke('diff:rejectAll'),
    onShowDiff: (handler: (path: string, before: string, after: string, lang: string) => void) => {
      ipcRenderer.on('agent:show_diff', (_e, p, b, a, l) => handler(p, b, a, l))
      return () => ipcRenderer.removeAllListeners('agent:show_diff')
    },
    onQueued: (handler: (entries: { path: string; language: string }[]) => void) => {
      ipcRenderer.on('diff:queued', (_e, entries) => handler(entries))
      return () => ipcRenderer.removeAllListeners('diff:queued')
    },
  },
  approval: {
    respond: (id: string, approved: boolean) =>
      ipcRenderer.invoke('approval:respond', id, approved),
  },
  storage: {
    get: (key: string) => ipcRenderer.invoke('storage:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('storage:set', key, value),
  },
  lmStudio: {
    test: (url: string, apiKey?: string) => ipcRenderer.invoke('lmstudio:test', url, apiKey),
    models: () => ipcRenderer.invoke('lmstudio:models'),
  },
  menu: {
    onSettings: (handler: () => void) => {
      ipcRenderer.on('menu:settings', () => handler())
      return () => ipcRenderer.removeAllListeners('menu:settings')
    },
  },
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    getKey: (provider: 'anthropic' | 'openai' | 'lmstudio') =>
      ipcRenderer.invoke('settings:getKey', provider),
    setKey: (provider: 'anthropic' | 'openai' | 'lmstudio', key: string) =>
      ipcRenderer.invoke('settings:setKey', provider, key),
    availableProviders: () => ipcRenderer.invoke('settings:availableProviders'),
  },
  index: {
    query: (pattern: string) => ipcRenderer.invoke('index:query', pattern),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
  },
})
