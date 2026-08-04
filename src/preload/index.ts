import { contextBridge, ipcRenderer } from 'electron'
import type { AutoApprovalLevel } from '@shared/auto-approval.ts'

contextBridge.exposeInMainWorld('api', {
  workspace: {
    open: () => ipcRenderer.invoke('workspace:open'),
    get: () => ipcRenderer.invoke('workspace:get'),
    set: (root: string, sshHost?: string) => ipcRenderer.invoke('workspace:set', root, sshHost),
    isTrusted: () => ipcRenderer.invoke('workspace:isTrusted'),
    setTrusted: (trusted: boolean) => ipcRenderer.invoke('workspace:setTrusted', trusted),
    unsandboxedProjectHooks: () => ipcRenderer.invoke('hooks:unsandboxedProjectHooks'),
    onOpened: (handler: (root: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, root: string): void => {
        handler(root)
      }
      ipcRenderer.on('workspace:opened', listener)
      return (): void => {
        ipcRenderer.off('workspace:opened', listener)
      }
    },
  },
  browser: {
    onOpenTab: (handler: (url: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, url: string): void => {
        handler(url)
      }
      ipcRenderer.on('browser:open-tab', listener)
      return (): void => {
        ipcRenderer.off('browser:open-tab', listener)
      }
    },
    onPackTabRequest: (
      handler: (
        request: import('@shared/types/pack-browser.ts').PackBrowserTabRequest,
      ) => Promise<{ tabId: string; webContentsId: number }>,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        request: import('@shared/types/pack-browser.ts').PackBrowserTabRequest,
      ): void => {
        void handler(request).then(
          (ready) => {
            ipcRenderer.send('packs:browser-tab-ready', {
              requestId: request.requestId,
              ok: true,
              ...ready,
            })
          },
          (error: unknown) => {
            ipcRenderer.send('packs:browser-tab-ready', {
              requestId: request.requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          },
        )
      }
      ipcRenderer.on('packs:browser-tab-request', listener)
      return (): void => {
        ipcRenderer.off('packs:browser-tab-request', listener)
      }
    },
  },
  security: {
    getGuardedYolo: (threadId: string) => ipcRenderer.invoke('security:getGuardedYolo', threadId),
    enableGuardedYolo: (threadId: string) =>
      ipcRenderer.invoke('security:enableGuardedYolo', threadId),
    disableGuardedYolo: (threadId: string) =>
      ipcRenderer.invoke('security:disableGuardedYolo', threadId),
    onGuardedYoloChanged: (
      handler: (state: import('@shared/types/guarded-yolo.ts').GuardedYoloState) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        state: import('@shared/types/guarded-yolo.ts').GuardedYoloState,
      ): void => {
        handler(state)
      }
      ipcRenderer.on('security:guardedYoloChanged', listener)
      return (): void => {
        ipcRenderer.off('security:guardedYoloChanged', listener)
      }
    },
  },
  fs: {
    readFile: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('fs:readFile', projectId, threadId, path),
    writeFile: (projectId: string, threadId: string, path: string, content: string) =>
      ipcRenderer.invoke('fs:writeFile', projectId, threadId, path, content),
    readdir: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('fs:readdir', projectId, threadId, path),
    listDir: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('fs:listDir', projectId, threadId, path),
    watch: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('fs:watch', projectId, threadId, path),
    unwatch: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('fs:unwatch', projectId, threadId, path),
    onChanged: (
      handler: (projectId: string, threadId: string, path: string, content: string | null) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        projectId: string,
        threadId: string,
        path: string,
        content: string | null,
      ): void => {
        handler(projectId, threadId, path, content)
      }
      ipcRenderer.on('fs:changed', listener)
      return (): void => {
        ipcRenderer.off('fs:changed', listener)
      }
    },
  },
  agent: {
    run: (projectId: string, threadId: string, prompt: string) =>
      ipcRenderer.invoke('agent:run', projectId, threadId, prompt),
    describeImages: (
      projectId: string,
      threadId: string,
      model: string,
      userPrompt: string,
      images: string[],
    ) => ipcRenderer.invoke('agent:describeImages', projectId, threadId, model, userPrompt, images),
    prepareCheckout: (
      projectId: string,
      threadId: string,
      prompt: string,
      choice: 'automatic' | 'shared' | 'worktree',
      model?: string,
    ) => ipcRenderer.invoke('agent:prepareCheckout', projectId, threadId, prompt, choice, model),
    previewCheckout: (
      projectId: string,
      choice: 'automatic' | 'shared' | 'worktree',
      model?: string,
    ) => ipcRenderer.invoke('agent:previewCheckout', projectId, choice, model),
    estimateContext: (projectId: string, threadId: string, payload: string) =>
      ipcRenderer.invoke('agent:estimateContext', projectId, threadId, payload),
    abort: (threadId: string) => ipcRenderer.invoke('agent:abort', threadId),
    retryReview: (projectId: string, threadId: string, payload: string) =>
      ipcRenderer.invoke('agent:retryReview', projectId, threadId, payload),
    retryComparison: (projectId: string, threadId: string, payload: string) =>
      ipcRenderer.invoke('agent:retryComparison', projectId, threadId, payload),
    clearHistory: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('agent:clearHistory', projectId, threadId),
    refreshModelContext: () => ipcRenderer.invoke('agent:refreshModelContext'),
    suggestTitle: (text: string) => ipcRenderer.invoke('agent:suggestTitle', text),
    suggestTerminalTitle: (text: string) => ipcRenderer.invoke('agent:suggestTerminalTitle', text),
    suggestCommandSummary: (commands: string[]) =>
      ipcRenderer.invoke('agent:suggestCommandSummary', commands),
    suggestToolTurnSummary: (actions: string[]) =>
      ipcRenderer.invoke('agent:suggestToolTurnSummary', actions),
    suggestFollowUps: (contextJson: string) =>
      ipcRenderer.invoke('agent:suggestFollowUps', contextJson),
    onChunk: (handler: (threadId: string, chunk: unknown) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, tid: string, chunk: unknown): void => {
        handler(tid, chunk)
      }
      ipcRenderer.on('agent:chunk', listener)
      return (): void => {
        ipcRenderer.off('agent:chunk', listener)
      }
    },
    onApprovalRequest: (
      handler: (req: {
        id: string
        threadId?: string
        title: string
        body: string
        bodyAdvice?: string
        bodyFooter?: string
        type: string
        allowRemember?: boolean
        rememberLabel?: string
        showWhileSettingsOpen?: boolean
        comparisonModels?: { a: string; b: string; judge: string }
      }) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        req: {
          id: string
          threadId?: string
          title: string
          body: string
          bodyAdvice?: string
          bodyFooter?: string
          type: string
          allowRemember?: boolean
          rememberLabel?: string
          comparisonModels?: { a: string; b: string; judge: string }
        },
      ): void => {
        handler(req)
      }
      ipcRenderer.on('agent:approval_request', listener)
      return (): void => {
        ipcRenderer.off('agent:approval_request', listener)
      }
    },
    onApprovalCancelled: (handler: (req: { id: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, req: { id: string }): void => {
        handler(req)
      }
      ipcRenderer.on('agent:approval_cancelled', listener)
      return (): void => {
        ipcRenderer.off('agent:approval_cancelled', listener)
      }
    },
    onAskUserRequest: (
      handler: (req: {
        id: string
        threadId?: string
        questions: { question: string; options?: string[] }[]
      }) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        req: {
          id: string
          threadId?: string
          questions: { question: string; options?: string[] }[]
        },
      ): void => {
        handler(req)
      }
      ipcRenderer.on('agent:ask_user_request', listener)
      return (): void => {
        ipcRenderer.off('agent:ask_user_request', listener)
      }
    },
    onShellOutput: (handler: (data: string, toolCallId: string | null) => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        data: string,
        toolCallId: string | null,
      ): void => {
        handler(data, toolCallId)
      }
      ipcRenderer.on('agent:shell_output', listener)
      return (): void => {
        ipcRenderer.off('agent:shell_output', listener)
      }
    },
    onRefreshContextEstimate: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('agent:refresh_context_estimate', listener)
      return (): void => {
        ipcRenderer.off('agent:refresh_context_estimate', listener)
      }
    },
    onHookQueueMessage: (
      handler: (payload: import('@shared/types/hooks.ts').HookQueueMessagePayload) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        payload: import('@shared/types/hooks.ts').HookQueueMessagePayload,
      ): void => {
        handler(payload)
      }
      ipcRenderer.on('agent:hook_queue_message', listener)
      return (): void => {
        ipcRenderer.off('agent:hook_queue_message', listener)
      }
    },
  },
  diff: {
    approve: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('diff:approve', projectId, threadId, path),
    reject: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('diff:reject', projectId, threadId, path),
    approveAll: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('diff:approveAll', projectId, threadId),
    rejectAll: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('diff:rejectAll', projectId, threadId),
    content: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('diff:content', projectId, threadId, path),
    onShowDiff: (
      handler: (
        projectId: string,
        threadId: string,
        path: string,
        before: string,
        after: string,
        lang: string,
      ) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        projectId: string,
        threadId: string,
        p: string,
        b: string,
        a: string,
        l: string,
      ): void => {
        handler(projectId, threadId, p, b, a, l)
      }
      ipcRenderer.on('agent:show_diff', listener)
      return (): void => {
        ipcRenderer.off('agent:show_diff', listener)
      }
    },
    onQueued: (
      handler: (
        projectId: string,
        threadId: string,
        entries: { path: string; language: string }[],
      ) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        projectId: string,
        threadId: string,
        entries: { path: string; language: string }[],
      ): void => {
        handler(projectId, threadId, entries)
      }
      ipcRenderer.on('diff:queued', listener)
      return (): void => {
        ipcRenderer.off('diff:queued', listener)
      }
    },
    onConflict: (handler: (projectId: string, threadId: string, paths: string[]) => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        projectId: string,
        threadId: string,
        paths: string[],
      ): void => {
        handler(projectId, threadId, paths)
      }
      ipcRenderer.on('diff:conflict', listener)
      return (): void => {
        ipcRenderer.off('diff:conflict', listener)
      }
    },
  },
  approval: {
    respond: (
      id: string,
      approved: boolean,
      remember?: boolean,
      comparisonModels?: { a: string; b: string; judge: string },
    ) => ipcRenderer.invoke('approval:respond', id, approved, remember, comparisonModels),
  },
  ask: {
    respond: (id: string, answers: string[]) => ipcRenderer.invoke('ask:respond', id, answers),
  },
  alerts: {
    threadFinished: (threadId: string, title: string) =>
      ipcRenderer.invoke('alerts:threadFinished', threadId, title),
  },
  sshPrompt: {
    respond: (id: string, value: string, remember = false) =>
      ipcRenderer.invoke('ssh-prompt:respond', id, value, remember),
    onRequest: (
      handler: (req: { id: string; prompt: string; kind: 'confirm' | 'secret' }) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        req: { id: string; prompt: string; kind: 'confirm' | 'secret' },
      ): void => {
        handler(req)
      }
      ipcRenderer.on('ssh:prompt_request', listener)
      return (): void => {
        ipcRenderer.off('ssh:prompt_request', listener)
      }
    },
  },
  updatePrompt: {
    respond: (id: string, buttonIndex: number) =>
      ipcRenderer.invoke('update-prompt:respond', id, buttonIndex),
    onRequest: (
      handler: (req: {
        id: string
        message: string
        detail?: string
        buttons: string[]
        defaultIndex?: number
        cancelIndex?: number
      }) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        req: {
          id: string
          message: string
          detail?: string
          buttons: string[]
          defaultIndex?: number
          cancelIndex?: number
        },
      ): void => {
        handler(req)
      }
      ipcRenderer.on('update:prompt_request', listener)
      return (): void => {
        ipcRenderer.off('update:prompt_request', listener)
      }
    },
    onDevNotice: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('update:dev_notice', listener)
      return (): void => {
        ipcRenderer.off('update:dev_notice', listener)
      }
    },
  },
  sshWorkspace: {
    listHosts: () => ipcRenderer.invoke('ssh-workspace:listHosts'),
    listConfigAliases: () => ipcRenderer.invoke('ssh-workspace:listConfigAliases'),
    getStates: () => ipcRenderer.invoke('ssh-workspace:getStates'),
    connect: (hostId: string) => ipcRenderer.invoke('ssh-workspace:connect', hostId),
    disconnect: (hostId: string) => ipcRenderer.invoke('ssh-workspace:disconnect', hostId),
    reconnect: (hostId: string) => ipcRenderer.invoke('ssh-workspace:reconnect', hostId),
    listDirectory: (hostId: string, dirPath: string) =>
      ipcRenderer.invoke('ssh-workspace:listDirectory', hostId, dirPath),
    registerRoot: (hostId: string, dirPath: string) =>
      ipcRenderer.invoke('ssh-workspace:registerRoot', hostId, dirPath),
    onConnectionChanged: (
      handler: (states: import('@shared/types/ssh-workspace.ts').SshConnectionState[]) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        states: import('@shared/types/ssh-workspace.ts').SshConnectionState[],
      ): void => {
        handler(states)
      }
      ipcRenderer.on('ssh:connection_changed', listener)
      return (): void => {
        ipcRenderer.off('ssh:connection_changed', listener)
      }
    },
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
      const listener = (_e: Electron.IpcRendererEvent, statuses: unknown): void => {
        handler(statuses)
      }
      ipcRenderer.on('mcp:status_changed', listener)
      return (): void => {
        ipcRenderer.off('mcp:status_changed', listener)
      }
    },
  },
  canvas: {
    onArtefact: (handler: (artefact: import('@shared/types/canvas.ts').CanvasArtefact) => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        artefact: import('@shared/types/canvas.ts').CanvasArtefact,
      ): void => {
        handler(artefact)
      }
      ipcRenderer.on('canvas:artefact', listener)
      return (): void => {
        ipcRenderer.off('canvas:artefact', listener)
      }
    },
  },
  storage: {
    get: (key: string) => ipcRenderer.invoke('storage:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('storage:set', key, value),
  },
  threads: {
    loadProject: (projectId: string) => ipcRenderer.invoke('threads:loadProject', projectId),
    create: (projectId: string, thread: import('@shared/types').Thread) =>
      ipcRenderer.invoke('threads:create', projectId, thread),
    appendMessage: (
      projectId: string,
      threadId: string,
      message: import('@shared/types').Message,
    ) => ipcRenderer.invoke('threads:appendMessage', projectId, threadId, message),
    updateMeta: (
      projectId: string,
      threadId: string,
      patch: Partial<Omit<import('@shared/types').Thread, 'messages'>>,
    ) => ipcRenderer.invoke('threads:updateMeta', projectId, threadId, patch),
    delete: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('threads:delete', projectId, threadId),
    exportArchive: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('threads:exportArchive', projectId, threadId),
    fork: (
      projectId: string,
      sourceThreadId: string,
      targetThreadId: string,
      throughMessageId?: string,
    ) =>
      ipcRenderer.invoke(
        'threads:fork',
        projectId,
        sourceThreadId,
        targetThreadId,
        throughMessageId,
      ),
    catalog: (projectId: string, query?: string) =>
      ipcRenderer.invoke('threads:catalog', projectId, query),
    listOrphans: () => ipcRenderer.invoke('threads:listOrphans'),
  },
  archive: {
    attach: (
      projectId: string,
      threadId: string,
      archive: { name: string; bytes?: Uint8Array; path?: string },
    ) => ipcRenderer.invoke('archive:attach', projectId, threadId, archive),
  },
  video: {
    attach: (
      projectId: string,
      threadId: string,
      video: { name: string; mimeType: string; bytes?: Uint8Array; path?: string },
    ) => ipcRenderer.invoke('video:attach', projectId, threadId, video),
    read: (path: string) => ipcRenderer.invoke('video:read', path),
  },
  intellect: {
    liveModels: () => ipcRenderer.invoke('intellect:live-models'),
  },
  lmStudio: {
    test: (url: string, apiKey?: string) => ipcRenderer.invoke('lmstudio:test', url, apiKey),
    models: () => ipcRenderer.invoke('lmstudio:models'),
    modelInfo: () => ipcRenderer.invoke('lmstudio:modelInfo'),
    detect: (url?: string, apiKey?: string) => ipcRenderer.invoke('lmstudio:detect', url, apiKey),
    download: (modelId: string, url?: string, apiKey?: string) =>
      ipcRenderer.invoke('lmstudio:download', modelId, url, apiKey),
    downloadStatus: (jobId: string, url?: string, apiKey?: string) =>
      ipcRenderer.invoke('lmstudio:downloadStatus', jobId, url, apiKey),
  },
  openRouter: {
    models: () => ipcRenderer.invoke('openrouter:models'),
  },
  models: {
    chatDefaultContextHealth: () => ipcRenderer.invoke('models:chatDefaultContextHealth'),
    bestValueDefault: () => ipcRenderer.invoke('models:bestValueDefault'),
  },
  menu: {
    onSettings: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:settings', listener)
      return (): void => {
        ipcRenderer.off('menu:settings', listener)
      }
    },
    onNewThread: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:newThread', listener)
      return (): void => {
        ipcRenderer.off('menu:newThread', listener)
      }
    },
    onTogglePanel: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:togglePanel', listener)
      return (): void => {
        ipcRenderer.off('menu:togglePanel', listener)
      }
    },
    onShowExplorer: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:showExplorer', listener)
      return (): void => {
        ipcRenderer.off('menu:showExplorer', listener)
      }
    },
    onShowTerminal: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:showTerminal', listener)
      return (): void => {
        ipcRenderer.off('menu:showTerminal', listener)
      }
    },
    onShowChanges: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:showChanges', listener)
      return (): void => {
        ipcRenderer.off('menu:showChanges', listener)
      }
    },
    onShowBrowser: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:showBrowser', listener)
      return (): void => {
        ipcRenderer.off('menu:showBrowser', listener)
      }
    },
    onFocusBrowserUrlBar: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:focusBrowserUrlBar', listener)
      return (): void => {
        ipcRenderer.off('menu:focusBrowserUrlBar', listener)
      }
    },
    onKeyboardShortcuts: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:keyboardShortcuts', listener)
      return (): void => {
        ipcRenderer.off('menu:keyboardShortcuts', listener)
      }
    },
    onUiScaleZoomIn: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:uiScaleZoomIn', listener)
      return (): void => {
        ipcRenderer.off('menu:uiScaleZoomIn', listener)
      }
    },
    onUiScaleZoomOut: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:uiScaleZoomOut', listener)
      return (): void => {
        ipcRenderer.off('menu:uiScaleZoomOut', listener)
      }
    },
    onUiScaleReset: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:uiScaleReset', listener)
      return (): void => {
        ipcRenderer.off('menu:uiScaleReset', listener)
      }
    },
  },
  remoteAgent: {
    downloadArtifact: (agentId: string, path: string) =>
      ipcRenderer.invoke('remoteAgent:downloadArtifact', agentId, path),
    artifactImageDataUrl: (agentId: string, path: string) =>
      ipcRenderer.invoke('remoteAgent:artifactImageDataUrl', agentId, path),
    models: () => ipcRenderer.invoke('remoteAgent:models'),
    /** Import outside Cursor cloud agents as local thread stubs for a project. */
    discoverExternal: (projectId?: string) =>
      ipcRenderer.invoke('remoteAgent:discoverExternal', projectId),
  },
  acp: {
    detectAgents: () => ipcRenderer.invoke('acp:detectAgents'),
    probeAgent: (agentId: string) => ipcRenderer.invoke('acp:probeAgent', agentId),
    autoSetup: () => ipcRenderer.invoke('acp:autoSetup'),
  },
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    setSecurity: (prefs: {
      localServerUrl: string
      safetyClassifierEnabled: boolean
      safetyExternalDenyThreshold: number
      safetyModel: string
      reviewModel?: string
      autoRunSandboxCommands: boolean
      mcpAutoAllowReadOnly: boolean
      defaultReadonlyMode: boolean
      webAllowedOrigins: string[]
      webAllowUserApproval: boolean
      approvedProviderHosts?: string[]
      providerAllowUserApproval?: boolean
      trustedShellCommands?: string[]
      // Highest auto-approval tier for recognised low-risk shell shapes. Optional so
      // bundles that don't render the picker don't reset the user's choice.
      shellAutoApprovalLevel?: AutoApprovalLevel
    }) => ipcRenderer.invoke('settings:setSecurity', prefs),
    getKey: (provider: string) => ipcRenderer.invoke('settings:getKey', provider),
    getKeyEncrypted: (provider: string) => ipcRenderer.invoke('settings:getKeyEncrypted', provider),
    setKey: (provider: string, key: string, opts?: { allowPlaintext?: boolean }) =>
      ipcRenderer.invoke('settings:setKey', provider, key, opts),
    availableProviders: () => ipcRenderer.invoke('settings:availableProviders'),
    validateKey: (provider: string, key: string) =>
      ipcRenderer.invoke('settings:validateKey', provider, key),
    scanEnvKeys: () => ipcRenderer.invoke('settings:scanEnvKeys'),
    importEnvKeys: () => ipcRenderer.invoke('settings:importEnvKeys'),
    extraProviders: () => ipcRenderer.invoke('settings:extraProviders'),
    modelPricing: () => ipcRenderer.invoke('settings:modelPricing'),
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
  usage: {
    record: (input: import('@shared/usage/usage-event.ts').UsageRecordInput) =>
      ipcRenderer.invoke('usage:record', input),
    getSummary: () => ipcRenderer.invoke('usage:getSummary'),
    getPlanUsage: () => ipcRenderer.invoke('usage:getPlanUsage'),
    getPlanWorthIt: () => ipcRenderer.invoke('usage:getPlanWorthIt'),
    setClaudePlanMonthlyFee: (fee: number | null) =>
      ipcRenderer.invoke('usage:setClaudePlanMonthlyFee', fee),
  },
  decisions: {
    list: (projectId?: string) => ipcRenderer.invoke('decisions:list', projectId),
    export: (projectId?: string) => ipcRenderer.invoke('decisions:export', projectId),
  },
  index: {
    query: (pattern: string) => ipcRenderer.invoke('index:query', pattern),
    resolveFileReferences: (candidates: string[]) =>
      ipcRenderer.invoke('index:resolveFileReferences', candidates),
    status: () => ipcRenderer.invoke('index:status'),
    onStatusChanged: (handler: (status: unknown) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, status: unknown): void => {
        handler(status)
      }
      ipcRenderer.on('index:status_changed', listener)
      return (): void => {
        ipcRenderer.off('index:status_changed', listener)
      }
    },
  },
  memories: {
    list: () => ipcRenderer.invoke('memories:list'),
    create: (title: string, body: string, tags?: string[]) =>
      ipcRenderer.invoke('memories:create', title, body, tags),
    update: (id: string, title: string, body: string, tags?: string[]) =>
      ipcRenderer.invoke('memories:update', id, title, body, tags),
    delete: (id: string) => ipcRenderer.invoke('memories:delete', id),
  },
  roadmap: {
    list: () => ipcRenderer.invoke('roadmap:list'),
    create: (
      prompt: string,
      notes?: string,
      issue?: string,
      attachments?: { name: string; mimeType: string; dataUrl: string }[],
    ) => ipcRenderer.invoke('roadmap:create', prompt, notes, issue, attachments),
    update: (
      id: string,
      prompt: string,
      notes: string | undefined,
      status: string,
      issue?: string,
      addAttachments?: { name: string; mimeType: string; dataUrl: string }[],
      removeAttachmentIds?: string[],
    ) =>
      ipcRenderer.invoke(
        'roadmap:update',
        id,
        prompt,
        notes,
        status,
        issue,
        addAttachments,
        removeAttachmentIds,
      ),
    attachmentData: (id: string, attachmentId: string) =>
      ipcRenderer.invoke('roadmap:attachmentData', id, attachmentId),
    setStatus: (id: string, status: string) => ipcRenderer.invoke('roadmap:setStatus', id, status),
    setCategory: (id: string, category: string) =>
      ipcRenderer.invoke('roadmap:setCategory', id, category),
    delete: (id: string) => ipcRenderer.invoke('roadmap:delete', id),
    export: (format: string) => ipcRenderer.invoke('roadmap:export', format),
    issueUrl: (ref: string) => ipcRenderer.invoke('roadmap:issueUrl', ref),
    openIssues: (page: number) => ipcRenderer.invoke('roadmap:openIssues', page),
    importIssues: (issues: { number: number; title: string; body: string }[]) =>
      ipcRenderer.invoke('roadmap:importIssues', issues),
    matchOpenIssues: (issues: { number: number; title: string; body: string }[]) =>
      ipcRenderer.invoke('roadmap:matchOpenIssues', issues),
    checkFit: (id: string) => ipcRenderer.invoke('roadmap:checkFit', id),
    prepareReview: () => ipcRenderer.invoke('roadmap:prepareReview'),
    lastReviewAt: () => ipcRenderer.invoke('roadmap:lastReviewAt'),
    reviewItem: (id: string, commits: string, runId?: string) =>
      ipcRenderer.invoke('roadmap:reviewItem', id, commits, runId),
    reviewItemDeep: (id: string) => ipcRenderer.invoke('roadmap:reviewItemDeep', id),
    completeReview: (runId: string) => ipcRenderer.invoke('roadmap:completeReview', runId),
    abortReview: (runId: string) => ipcRenderer.invoke('roadmap:abortReview', runId),
    // Fired when a background complexity stamp lands on a saved item.
    onChanged: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('roadmap:changed', listener)
      return (): void => {
        ipcRenderer.off('roadmap:changed', listener)
      }
    },
    setThread: (id: string, threadId: string) =>
      ipcRenderer.invoke('roadmap:setThread', id, threadId),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
  },
  hooks: {
    list: () => ipcRenderer.invoke('hooks:list'),
    test: (req: unknown) => ipcRenderer.invoke('hooks:test', req),
  },
  packs: {
    list: () => ipcRenderer.invoke('packs:list'),
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('packs:setEnabled', id, enabled),
    setSetting: (id: string, key: string, value: unknown) =>
      ipcRenderer.invoke('packs:setSetting', id, key, value),
    addSource: () => ipcRenderer.invoke('packs:addSource'),
  },
  automations: {
    list: (projectId: string) => ipcRenderer.invoke('automations:list', projectId),
    upsert: (projectId: string, input: unknown) =>
      ipcRenderer.invoke('automations:upsert', projectId, input),
    remove: (projectId: string, scheduleId: string) =>
      ipcRenderer.invoke('automations:remove', projectId, scheduleId),
    runNow: (projectId: string, scheduleId: string) =>
      ipcRenderer.invoke('automations:runNow', projectId, scheduleId),
    onTriggered: (handler: (event: import('@shared/types').AutomationTriggerEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: import('@shared/types').AutomationTriggerEvent,
      ): void => {
        handler(payload)
      }
      ipcRenderer.on('automations:triggered', listener)
      return (): void => {
        ipcRenderer.off('automations:triggered', listener)
      }
    },
  },
  instructions: {
    list: () => ipcRenderer.invoke('instructions:list'),
  },
  cursorRules: {
    list: () => ipcRenderer.invoke('cursorRules:list'),
  },
  terminal: {
    create: (
      cols: number,
      rows: number,
      meta: { label?: string; projectId: string; threadId: string | null },
    ) => ipcRenderer.invoke('terminal:create', cols, rows, meta),
    write: (sessionId: string, data: string) =>
      ipcRenderer.invoke('terminal:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:resize', sessionId, cols, rows),
    destroy: (sessionId: string) => ipcRenderer.invoke('terminal:destroy', sessionId),
    setMeta: (sessionId: string, meta: { label?: string; threadId?: string | null }) =>
      ipcRenderer.invoke('terminal:setMeta', sessionId, meta),
    setActive: (sessionId: string) => ipcRenderer.invoke('terminal:setActive', sessionId),
    onOutput: (handler: (sessionId: string, data: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, id: string, data: string): void => {
        handler(id, data)
      }
      ipcRenderer.on('terminal:output', listener)
      return (): void => {
        ipcRenderer.off('terminal:output', listener)
      }
    },
    onExit: (handler: (sessionId: string, code: number) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, id: string, code: number): void => {
        handler(id, code)
      }
      ipcRenderer.on('terminal:exit', listener)
      return (): void => {
        ipcRenderer.off('terminal:exit', listener)
      }
    },
    onRunCommand: (handler: (command: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, command: string): void => {
        handler(command)
      }
      ipcRenderer.on('terminal:run_command', listener)
      return (): void => {
        ipcRenderer.off('terminal:run_command', listener)
      }
    },
  },
  git: {
    isAvailable: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:isAvailable', projectId, threadId),
    status: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:status', projectId, threadId),
    changeStats: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:changeStats', projectId, threadId),
    fileDiff: (projectId: string, threadId: string, path: string, staged: boolean) =>
      ipcRenderer.invoke('git:fileDiff', projectId, threadId, path, staged),
    workingFileDiff: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('git:workingFileDiff', projectId, threadId, path),
    branchStatus: (projectId: string, threadId: string, forBranch?: string) =>
      ipcRenderer.invoke('git:branchStatus', projectId, threadId, forBranch),
    promptState: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:promptState', projectId, threadId),
    checkoutBranch: (projectId: string, threadId: string, branch: string) =>
      ipcRenderer.invoke('git:checkoutBranch', projectId, threadId, branch),
    listBranches: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:listBranches', projectId, threadId),
    getDefaultBranch: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:getDefaultBranch', projectId, threadId),
    sessionBackup: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:sessionBackup', projectId, threadId),
    restoreBackup: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:restoreBackup', projectId, threadId),
  },
  gh: {
    status: () => ipcRenderer.invoke('gh:status'),
    listMyOpenPrs: () => ipcRenderer.invoke('gh:listMyOpenPrs'),
    listWorkspaceOpenPrs: () => ipcRenderer.invoke('gh:listWorkspaceOpenPrs'),
    prChecks: (owner: string, repo: string, number: number) =>
      ipcRenderer.invoke('gh:prChecks', owner, repo, number),
    prDetails: (owner: string, repo: string, number: number) =>
      ipcRenderer.invoke('gh:prDetails', owner, repo, number),
    prFileDiff: (owner: string, repo: string, number: number, path: string) =>
      ipcRenderer.invoke('gh:prFileDiff', owner, repo, number, path),
    resolvePrUrl: (url: string) => ipcRenderer.invoke('gh:resolvePrUrl', url),
    agentPrLinks: () => ipcRenderer.invoke('gh:agentPrLinks'),
    rerunFailedRuns: (owner: string, repo: string, number: number) =>
      ipcRenderer.invoke('gh:rerunFailedRuns', owner, repo, number),
    approvePr: (owner: string, repo: string, number: number) =>
      ipcRenderer.invoke('gh:approvePr', owner, repo, number),
    markPrReady: (owner: string, repo: string, number: number) =>
      ipcRenderer.invoke('gh:markPrReady', owner, repo, number),
    enableAutoMerge: (owner: string, repo: string, number: number) =>
      ipcRenderer.invoke('gh:enableAutoMerge', owner, repo, number),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },
  editors: {
    list: () => ipcRenderer.invoke('editors:list'),
    open: (projectId: string, threadId: string, editorId: string) =>
      ipcRenderer.invoke('editors:open', projectId, threadId, editorId),
  },
  panes: {
    popout: (mode: string, seed?: unknown) => ipcRenderer.invoke('panes:popout', mode, seed),
    takePopoutSeed: (mode: string) => ipcRenderer.invoke('panes:takePopoutSeed', mode),
    onSwitchMode: (handler: (mode: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, mode: string): void => {
        handler(mode)
      }
      ipcRenderer.on('popout:switch-mode', listener)
      return () => {
        ipcRenderer.removeListener('popout:switch-mode', listener)
      }
    },
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
    setMockScript(script: unknown) {
      return ipcRenderer.invoke('test:setMockScript', script)
    },
    clearMockScript() {
      return ipcRenderer.invoke('test:clearMockScript')
    },
    requestSshPrompt(prompt: string, kind: 'confirm' | 'secret') {
      return ipcRenderer.invoke('test:requestSshPrompt', prompt, kind)
    },
    requestAcpPackageInstallApproval() {
      return ipcRenderer.invoke('test:requestAcpPackageInstallApproval')
    },
    requestAcpPackageUpgradeApproval() {
      return ipcRenderer.invoke('test:requestAcpPackageUpgradeApproval')
    },
    emitAgentChunks(threadId: string, chunks: unknown[]) {
      return ipcRenderer.invoke('test:emitAgentChunks', threadId, chunks)
    },
    setSemanticIndexScaleGuard(phase: 'limited' | 'skipped', reason: string) {
      return ipcRenderer.invoke('test:setSemanticIndexScaleGuard', phase, reason)
    },
  })
}
