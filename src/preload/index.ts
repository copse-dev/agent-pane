import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  workspace: {
    open: () => ipcRenderer.invoke('workspace:open'),
    get: () => ipcRenderer.invoke('workspace:get'),
    set: (root: string) => ipcRenderer.invoke('workspace:set', root),
    onOpened: (handler: (root: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, root: string) => handler(root)
      ipcRenderer.on('workspace:opened', listener)
      return () => ipcRenderer.off('workspace:opened', listener)
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
      const listener = (_e: Electron.IpcRendererEvent, p: string, c: string) => handler(p, c)
      ipcRenderer.on('fs:changed', listener)
      return () => ipcRenderer.off('fs:changed', listener)
    },
  },
  agent: {
    run: (threadId: string, prompt: string) => ipcRenderer.invoke('agent:run', threadId, prompt),
    abort: (threadId: string) => ipcRenderer.invoke('agent:abort', threadId),
    clearHistory: (threadId: string) => ipcRenderer.invoke('agent:clearHistory', threadId),
    suggestTitle: (text: string) => ipcRenderer.invoke('agent:suggestTitle', text),
    onChunk: (handler: (threadId: string, chunk: unknown) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, tid: string, chunk: unknown) =>
        handler(tid, chunk)
      ipcRenderer.on('agent:chunk', listener)
      return () => ipcRenderer.off('agent:chunk', listener)
    },
    onApprovalRequest: (
      handler: (req: { id: string; title: string; body: string; type: string }) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        req: { id: string; title: string; body: string; type: string },
      ) => handler(req)
      ipcRenderer.on('agent:approval_request', listener)
      return () => ipcRenderer.off('agent:approval_request', listener)
    },
    onShellOutput: (handler: (data: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, data: string) => handler(data)
      ipcRenderer.on('agent:shell_output', listener)
      return () => ipcRenderer.off('agent:shell_output', listener)
    },
    onUsage: (
      handler: (threadId: string, usage: { inputTokens: number; outputTokens: number }) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        threadId: string,
        usage: { inputTokens: number; outputTokens: number },
      ) => handler(threadId, usage)
      ipcRenderer.on('agent:usage', listener)
      return () => ipcRenderer.off('agent:usage', listener)
    },
  },
  diff: {
    approve: (path: string) => ipcRenderer.invoke('diff:approve', path),
    reject: (path: string) => ipcRenderer.invoke('diff:reject', path),
    approveAll: () => ipcRenderer.invoke('diff:approveAll'),
    rejectAll: () => ipcRenderer.invoke('diff:rejectAll'),
    onShowDiff: (handler: (path: string, before: string, after: string, lang: string) => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        p: string,
        b: string,
        a: string,
        l: string,
      ) => handler(p, b, a, l)
      ipcRenderer.on('agent:show_diff', listener)
      return () => ipcRenderer.off('agent:show_diff', listener)
    },
    onQueued: (handler: (entries: { path: string; language: string }[]) => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        entries: { path: string; language: string }[],
      ) => handler(entries)
      ipcRenderer.on('diff:queued', listener)
      return () => ipcRenderer.off('diff:queued', listener)
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
      const listener = () => handler()
      ipcRenderer.on('menu:settings', listener)
      return () => ipcRenderer.off('menu:settings', listener)
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
  terminal: {
    create: () => ipcRenderer.invoke('terminal:create'),
    write: (sessionId: string, data: string) =>
      ipcRenderer.invoke('terminal:write', sessionId, data),
    destroy: (sessionId: string) => ipcRenderer.invoke('terminal:destroy', sessionId),
    onOutput: (handler: (sessionId: string, data: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, id: string, data: string) =>
        handler(id, data)
      ipcRenderer.on('terminal:output', listener)
      return () => ipcRenderer.off('terminal:output', listener)
    },
    onExit: (handler: (sessionId: string, code: number) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, id: string, code: number) =>
        handler(id, code)
      ipcRenderer.on('terminal:exit', listener)
      return () => ipcRenderer.off('terminal:exit', listener)
    },
  },
})
