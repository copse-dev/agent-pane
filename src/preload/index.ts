import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  workspace: {
    open: () => ipcRenderer.invoke('workspace:open'),
    get: () => ipcRenderer.invoke('workspace:get'),
    set: (root: string) => ipcRenderer.invoke('workspace:set', root),
    isTrusted: () => ipcRenderer.invoke('workspace:isTrusted'),
    setTrusted: (trusted: boolean) => ipcRenderer.invoke('workspace:setTrusted', trusted),
    onOpened: (handler: (root: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, root: string) => handler(root)
      ipcRenderer.on('workspace:opened', listener)
      return () => ipcRenderer.off('workspace:opened', listener)
    },
  },
  browser: {
    onOpenTab: (handler: (url: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, url: string) => handler(url)
      ipcRenderer.on('browser:open-tab', listener)
      return () => ipcRenderer.off('browser:open-tab', listener)
    },
  },
  fs: {
    readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
    writeFile: (path: string, content: string) => ipcRenderer.invoke('fs:writeFile', path, content),
    readdir: (path: string) => ipcRenderer.invoke('fs:readdir', path),
    listDir: (path: string) => ipcRenderer.invoke('fs:listDir', path),
    watch: (path: string) => ipcRenderer.invoke('fs:watch', path),
    unwatch: (path: string) => ipcRenderer.invoke('fs:unwatch', path),
    onChanged: (handler: (path: string, content: string | null) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, p: string, c: string | null) => handler(p, c)
      ipcRenderer.on('fs:changed', listener)
      return () => ipcRenderer.off('fs:changed', listener)
    },
  },
  agent: {
    run: (threadId: string, prompt: string) => ipcRenderer.invoke('agent:run', threadId, prompt),
    estimateContext: (threadId: string, payload: string) =>
      ipcRenderer.invoke('agent:estimateContext', threadId, payload),
    abort: (threadId: string) => ipcRenderer.invoke('agent:abort', threadId),
    clearHistory: (threadId: string) => ipcRenderer.invoke('agent:clearHistory', threadId),
    suggestTitle: (text: string) => ipcRenderer.invoke('agent:suggestTitle', text),
    suggestTerminalTitle: (text: string) => ipcRenderer.invoke('agent:suggestTerminalTitle', text),
    suggestFollowUps: (contextJson: string) =>
      ipcRenderer.invoke('agent:suggestFollowUps', contextJson),
    onChunk: (handler: (threadId: string, chunk: unknown) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, tid: string, chunk: unknown) =>
        handler(tid, chunk)
      ipcRenderer.on('agent:chunk', listener)
      return () => ipcRenderer.off('agent:chunk', listener)
    },
    onApprovalRequest: (
      handler: (req: {
        id: string
        title: string
        body: string
        type: string
        allowRemember?: boolean
        rememberLabel?: string
      }) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        req: {
          id: string
          title: string
          body: string
          type: string
          allowRemember?: boolean
          rememberLabel?: string
        },
      ) => handler(req)
      ipcRenderer.on('agent:approval_request', listener)
      return () => ipcRenderer.off('agent:approval_request', listener)
    },
    onShellOutput: (handler: (data: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, data: string) => handler(data)
      ipcRenderer.on('agent:shell_output', listener)
      return () => ipcRenderer.off('agent:shell_output', listener)
    },
    onUsage: (handler: (threadId: string, usage: import('@shared/types').UsageDelta) => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        threadId: string,
        usage: import('@shared/types').UsageDelta,
      ) => handler(threadId, usage)
      ipcRenderer.on('agent:usage', listener)
      return () => ipcRenderer.off('agent:usage', listener)
    },
    onRefreshContextEstimate: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on('agent:refresh_context_estimate', listener)
      return () => ipcRenderer.off('agent:refresh_context_estimate', listener)
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
    onConflict: (handler: (paths: string[]) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, paths: string[]) => handler(paths)
      ipcRenderer.on('diff:conflict', listener)
      return () => ipcRenderer.off('diff:conflict', listener)
    },
  },
  approval: {
    respond: (id: string, approved: boolean, remember?: boolean) =>
      ipcRenderer.invoke('approval:respond', id, approved, remember),
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    reload: () => ipcRenderer.invoke('mcp:reload'),
    setEnabled: (name: string, enabled: boolean) =>
      ipcRenderer.invoke('mcp:setEnabled', name, enabled),
    listCurated: () => ipcRenderer.invoke('mcp:listCurated'),
    setCuratedEnabled: (name: string, enabled: boolean) =>
      ipcRenderer.invoke('mcp:setCuratedEnabled', name, enabled),
    onStatusChanged: (handler: (statuses: unknown) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, statuses: unknown) => handler(statuses)
      ipcRenderer.on('mcp:status_changed', listener)
      return () => ipcRenderer.off('mcp:status_changed', listener)
    },
  },
  canvas: {
    onArtefact: (handler: (artefact: import('@shared/types/canvas.ts').CanvasArtefact) => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        artefact: import('@shared/types/canvas.ts').CanvasArtefact,
      ) => handler(artefact)
      ipcRenderer.on('canvas:artefact', listener)
      return () => ipcRenderer.off('canvas:artefact', listener)
    },
  },
  storage: {
    get: (key: string) => ipcRenderer.invoke('storage:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('storage:set', key, value),
  },
  lmStudio: {
    test: (url: string, apiKey?: string) => ipcRenderer.invoke('lmstudio:test', url, apiKey),
    models: () => ipcRenderer.invoke('lmstudio:models'),
    detect: (url?: string, apiKey?: string) => ipcRenderer.invoke('lmstudio:detect', url, apiKey),
    download: (modelId: string, url?: string, apiKey?: string) =>
      ipcRenderer.invoke('lmstudio:download', modelId, url, apiKey),
    downloadStatus: (jobId: string, url?: string, apiKey?: string) =>
      ipcRenderer.invoke('lmstudio:downloadStatus', jobId, url, apiKey),
  },
  openRouter: {
    models: () => ipcRenderer.invoke('openrouter:models'),
  },
  menu: {
    onSettings: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on('menu:settings', listener)
      return () => ipcRenderer.off('menu:settings', listener)
    },
    onNewThread: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on('menu:newThread', listener)
      return () => ipcRenderer.off('menu:newThread', listener)
    },
    onTogglePanel: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on('menu:togglePanel', listener)
      return () => ipcRenderer.off('menu:togglePanel', listener)
    },
    onShowExplorer: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on('menu:showExplorer', listener)
      return () => ipcRenderer.off('menu:showExplorer', listener)
    },
    onShowTerminal: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on('menu:showTerminal', listener)
      return () => ipcRenderer.off('menu:showTerminal', listener)
    },
    onShowChanges: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on('menu:showChanges', listener)
      return () => ipcRenderer.off('menu:showChanges', listener)
    },
    onShowBrowser: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on('menu:showBrowser', listener)
      return () => ipcRenderer.off('menu:showBrowser', listener)
    },
  },
  remoteAgent: {
    downloadArtifact: (agentId: string, path: string) =>
      ipcRenderer.invoke('remoteAgent:downloadArtifact', agentId, path),
    artifactImageDataUrl: (agentId: string, path: string) =>
      ipcRenderer.invoke('remoteAgent:artifactImageDataUrl', agentId, path),
  },
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    setSecurity: (prefs: {
      localServerUrl: string
      safetyClassifierEnabled: boolean
      safetyConfidenceThreshold: number
      safetyModel: string
      reviewModel?: string
      autoRunSandboxCommands: boolean
      mcpAutoAllowReadOnly: boolean
      defaultReadonlyMode: boolean
      webAllowedOrigins: string[]
      webAllowUserApproval: boolean
    }) => ipcRenderer.invoke('settings:setSecurity', prefs),
    getKey: (provider: string) => ipcRenderer.invoke('settings:getKey', provider),
    setKey: (provider: string, key: string) => ipcRenderer.invoke('settings:setKey', provider, key),
    availableProviders: () => ipcRenderer.invoke('settings:availableProviders'),
    validateKey: (provider: string, key: string) =>
      ipcRenderer.invoke('settings:validateKey', provider, key),
    extraProviders: () => ipcRenderer.invoke('settings:extraProviders'),
    saveExtraProvider: (record: unknown) =>
      ipcRenderer.invoke('settings:saveExtraProvider', record),
    deleteExtraProvider: (slug: string) => ipcRenderer.invoke('settings:deleteExtraProvider', slug),
    fetchProviderModels: (baseUrl: string, apiKey?: string) =>
      ipcRenderer.invoke('settings:fetchProviderModels', baseUrl, apiKey),
    refreshHuggingFaceModels: (apiKey?: string) =>
      ipcRenderer.invoke('settings:refreshHuggingFaceModels', apiKey),
  },
  appIcon: {
    apply: () => ipcRenderer.invoke('app-icon:apply'),
  },
  index: {
    query: (pattern: string) => ipcRenderer.invoke('index:query', pattern),
    resolveFileReferences: (candidates: string[]) =>
      ipcRenderer.invoke('index:resolveFileReferences', candidates),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
  },
  hooks: {
    list: () => ipcRenderer.invoke('hooks:list'),
  },
  terminal: {
    create: (cols: number, rows: number) => ipcRenderer.invoke('terminal:create', cols, rows),
    write: (sessionId: string, data: string) =>
      ipcRenderer.invoke('terminal:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:resize', sessionId, cols, rows),
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
  git: {
    isAvailable: () => ipcRenderer.invoke('git:isAvailable'),
    status: () => ipcRenderer.invoke('git:status'),
    fileDiff: (path: string, staged: boolean) => ipcRenderer.invoke('git:fileDiff', path, staged),
    branchStatus: (forBranch?: string) => ipcRenderer.invoke('git:branchStatus', forBranch),
    checkoutBranch: (branch: string) => ipcRenderer.invoke('git:checkoutBranch', branch),
    listBranches: () => ipcRenderer.invoke('git:listBranches'),
    getDefaultBranch: () => ipcRenderer.invoke('git:getDefaultBranch'),
  },
  gh: {
    status: () => ipcRenderer.invoke('gh:status'),
    listMyOpenPrs: () => ipcRenderer.invoke('gh:listMyOpenPrs'),
    prDetails: (owner: string, repo: string, number: number) =>
      ipcRenderer.invoke('gh:prDetails', owner, repo, number),
    prFileDiff: (owner: string, repo: string, number: number, path: string) =>
      ipcRenderer.invoke('gh:prFileDiff', owner, repo, number, path),
    resolvePrUrl: (url: string) => ipcRenderer.invoke('gh:resolvePrUrl', url),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },
})

if (process.env['COPSE_E2E'] === '1') {
  const errorToasts: string[] = []
  contextBridge.exposeInMainWorld('__copseE2e', {
    pushErrorToast(message: string) {
      errorToasts.push(message)
    },
    getErrorToasts() {
      return [...errorToasts]
    },
  })
}
