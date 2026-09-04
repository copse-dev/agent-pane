import { contextBridge, ipcRenderer } from 'electron'
import type { AutoApprovalLevel } from '@shared/auto-approval.ts'
import type { ApiClient } from './api.d.ts'
import { exposePerfBridge, installPreloadPerfTracing } from './perf-bridge.ts'

// DEBUG BRANCH (`COPSE_PERF=1` only): patch `invoke` before the API object below
// captures it, so every channel the renderer calls is timed. No-op otherwise.
installPreloadPerfTracing()
exposePerfBridge()

// Typed against the contract so the facade cannot drift from `ApiClient`: a
// missing, extra, or mistyped member fails typecheck here, and the API protocol
// schema (`pnpm run gen:api-protocol`) is generated from this binding.
const api: ApiClient = {
  windowState: {
    getNavigation: () => ipcRenderer.invoke('main-window:get-navigation'),
    setNavigation: (navigation: import('@shared/types/main-window.ts').MainWindowNavigation) =>
      ipcRenderer.invoke('main-window:set-navigation', navigation),
  },
  workspace: {
    open: () => ipcRenderer.invoke('workspace:open'),
    get: () => ipcRenderer.invoke('workspace:get'),
    set: (root: string, sshHost?: string) => ipcRenderer.invoke('workspace:set', root, sshHost),
    isTrusted: () => ipcRenderer.invoke('workspace:is-trusted'),
    setTrusted: (trusted: boolean) => ipcRenderer.invoke('workspace:set-trusted', trusted),
    createNewProject: (name: string, parentDir: string) =>
      ipcRenderer.invoke('workspace:create-project', name, parentDir),
    pickParentDirectory: () => ipcRenderer.invoke('workspace:pick-parent-directory'),
    getHomeDirectory: () => ipcRenderer.invoke('workspace:get-home-directory'),
    unsandboxedProjectHooks: () => ipcRenderer.invoke('hooks:unsandboxed-project-hooks'),
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
    workspaceFileUrl: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('browser:workspace-file-url', projectId, threadId, path),
    sharePageText: (webContentsId: number) =>
      ipcRenderer.invoke('browser:share-page-text', webContentsId),
    shareScreenshot: (webContentsId: number) =>
      ipcRenderer.invoke('browser:share-screenshot', webContentsId),
    exportPdf: (webContentsId: number) => ipcRenderer.invoke('browser:export-pdf', webContentsId),
    onOpenTab: (handler: (url: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, url: string): void => {
        handler(url)
      }
      ipcRenderer.on('browser:open-tab', listener)
      return (): void => {
        ipcRenderer.off('browser:open-tab', listener)
      }
    },
    onShowTab: (handler: (url: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, url: string): void => {
        handler(url)
      }
      ipcRenderer.on('browser:show-tab', listener)
      return (): void => {
        ipcRenderer.off('browser:show-tab', listener)
      }
    },
    onPreviewStale: (handler: (origin: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, origin: string): void => {
        handler(origin)
      }
      ipcRenderer.on('browser:preview-stale', listener)
      return (): void => {
        ipcRenderer.off('browser:preview-stale', listener)
      }
    },
    onShareText: (
      handler: (share: import('@shared/types/browser-share.ts').BrowserTextShare) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        share: import('@shared/types/browser-share.ts').BrowserTextShare,
      ): void => {
        handler(share)
      }
      ipcRenderer.on('browser:share-text', listener)
      return (): void => {
        ipcRenderer.off('browser:share-text', listener)
      }
    },
    onShareImage: (
      handler: (share: import('@shared/types/browser-share.ts').BrowserImageShare) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        share: import('@shared/types/browser-share.ts').BrowserImageShare,
      ): void => {
        handler(share)
      }
      ipcRenderer.on('browser:share-image', listener)
      return (): void => {
        ipcRenderer.off('browser:share-image', listener)
      }
    },
    onPluginTabRequest: (
      handler: (
        request: import('@shared/types/plugin-browser.ts').PluginBrowserTabRequest,
      ) => Promise<{ tabId: string; webContentsId: number }>,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        request: import('@shared/types/plugin-browser.ts').PluginBrowserTabRequest,
      ): void => {
        void handler(request).then(
          (ready) => {
            ipcRenderer.send('plugins:browser-tab-ready', {
              requestId: request.requestId,
              ok: true,
              ...ready,
            })
          },
          (error: unknown) => {
            ipcRenderer.send('plugins:browser-tab-ready', {
              requestId: request.requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          },
        )
      }
      ipcRenderer.on('plugins:browser-tab-request', listener)
      return (): void => {
        ipcRenderer.off('plugins:browser-tab-request', listener)
      }
    },
  },
  security: {
    getGuardedYolo: (threadId: string) => ipcRenderer.invoke('security:get-guarded-yolo', threadId),
    enableGuardedYolo: (threadId: string) =>
      ipcRenderer.invoke('security:enable-guarded-yolo', threadId),
    disableGuardedYolo: (threadId: string) =>
      ipcRenderer.invoke('security:disable-guarded-yolo', threadId),
    onGuardedYoloChanged: (
      handler: (state: import('@shared/types/guarded-yolo.ts').GuardedYoloState) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        state: import('@shared/types/guarded-yolo.ts').GuardedYoloState,
      ): void => {
        handler(state)
      }
      ipcRenderer.on('security:guarded-yolo-changed', listener)
      return (): void => {
        ipcRenderer.off('security:guarded-yolo-changed', listener)
      }
    },
  },
  fs: {
    readFile: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('fs:read-file', projectId, threadId, path),
    writeFile: (projectId: string, threadId: string, path: string, content: string) =>
      ipcRenderer.invoke('fs:write-file', projectId, threadId, path, content),
    readdir: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('fs:readdir', projectId, threadId, path),
    listDir: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('fs:list-dir', projectId, threadId, path),
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
    ) =>
      ipcRenderer.invoke('agent:describe-images', projectId, threadId, model, userPrompt, images),
    prepareCheckout: (
      projectId: string,
      threadId: string,
      prompt: string,
      choice: 'automatic' | 'shared' | 'worktree',
      model?: string,
    ) => ipcRenderer.invoke('agent:prepare-checkout', projectId, threadId, prompt, choice, model),
    previewCheckout: (
      projectId: string,
      choice: 'automatic' | 'shared' | 'worktree',
      model?: string,
    ) => ipcRenderer.invoke('agent:preview-checkout', projectId, choice, model),
    resetDefaultBranchCache: () => ipcRenderer.invoke('agent:reset-default-branch-cache'),
    estimateContext: (projectId: string, threadId: string, payload: string) =>
      ipcRenderer.invoke('agent:estimate-context', projectId, threadId, payload),
    abort: (threadId: string) => ipcRenderer.invoke('agent:abort', threadId),
    runningThreadIds: () => ipcRenderer.invoke('agent:running-thread-ids'),
    retryReview: (projectId: string, threadId: string, payload: string) =>
      ipcRenderer.invoke('agent:retry-review', projectId, threadId, payload),
    retryComparison: (projectId: string, threadId: string, payload: string) =>
      ipcRenderer.invoke('agent:retry-comparison', projectId, threadId, payload),
    comparisonModels: (payload: string) => ipcRenderer.invoke('agent:comparison-models', payload),
    clearHistory: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('agent:clear-history', projectId, threadId),
    refreshModelContext: () => ipcRenderer.invoke('agent:refresh-model-context'),
    suggestTitle: (text: string) => ipcRenderer.invoke('agent:suggest-title', text),
    suggestTerminalTitle: (text: string) =>
      ipcRenderer.invoke('agent:suggest-terminal-title', text),
    suggestCommandSummary: (commands: string[]) =>
      ipcRenderer.invoke('agent:suggest-command-summary', commands),
    suggestToolTurnSummary: (actions: string[]) =>
      ipcRenderer.invoke('agent:suggest-tool-turn-summary', actions),
    suggestFollowUps: (projectId: string, threadId: string, contextJson: string) =>
      ipcRenderer.invoke('agent:suggest-follow-ups', projectId, threadId, contextJson),
    suggestNextStep: (contextJson: string) =>
      ipcRenderer.invoke('agent:suggest-next-step', contextJson),
    onChunk: (handler: (threadId: string, chunk: import('@shared/types').StreamChunk) => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        tid: string,
        chunk: import('@shared/types').StreamChunk,
      ): void => {
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
        collapseDetails?: boolean
        approveOnceLabel?: string
        showWhileSettingsOpen?: boolean
        comparisonModels?: { a: string; b: string; judge: string }
        allowTurnTreeLease?: boolean
        turnTreeLeaseLabel?: string
        turnTreeLeaseSubject?: string
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
          collapseDetails?: boolean
          approveOnceLabel?: string
          comparisonModels?: { a: string; b: string; judge: string }
          allowTurnTreeLease?: boolean
          turnTreeLeaseLabel?: string
          turnTreeLeaseDefault?: boolean
          turnTreeLeaseSubject?: string
        },
      ): void => {
        handler(req)
      }
      ipcRenderer.on('agent:approval-request', listener)
      return (): void => {
        ipcRenderer.off('agent:approval-request', listener)
      }
    },
    onApprovalCancelled: (handler: (req: { id: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, req: { id: string }): void => {
        handler(req)
      }
      ipcRenderer.on('agent:approval-cancelled', listener)
      return (): void => {
        ipcRenderer.off('agent:approval-cancelled', listener)
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
      ipcRenderer.on('agent:ask-user-request', listener)
      return (): void => {
        ipcRenderer.off('agent:ask-user-request', listener)
      }
    },
    onAskUserCancelled: (handler: (req: { id: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, req: { id: string }): void => {
        handler(req)
      }
      ipcRenderer.on('agent:ask-user-cancelled', listener)
      return (): void => {
        ipcRenderer.off('agent:ask-user-cancelled', listener)
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
      ipcRenderer.on('agent:shell-output', listener)
      return (): void => {
        ipcRenderer.off('agent:shell-output', listener)
      }
    },
    onRefreshContextEstimate: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('agent:refresh-context-estimate', listener)
      return (): void => {
        ipcRenderer.off('agent:refresh-context-estimate', listener)
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
      ipcRenderer.on('agent:hook-queue-message', listener)
      return (): void => {
        ipcRenderer.off('agent:hook-queue-message', listener)
      }
    },
  },
  diff: {
    approve: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('diff:approve', projectId, threadId, path),
    reject: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('diff:reject', projectId, threadId, path),
    approveAll: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('diff:approve-all', projectId, threadId),
    rejectAll: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('diff:reject-all', projectId, threadId),
    content: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('diff:content', projectId, threadId, path),
    queue: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('diff:queue', projectId, threadId),
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
      ipcRenderer.on('agent:show-diff', listener)
      return (): void => {
        ipcRenderer.off('agent:show-diff', listener)
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
      grantScope?: 'once' | 'turn-tree',
    ) =>
      ipcRenderer.invoke('approval:respond', id, approved, remember, comparisonModels, grantScope),
  },
  ask: {
    respond: (id: string, answers: string[]) => ipcRenderer.invoke('ask:respond', id, answers),
  },
  alerts: {
    threadFinished: (threadId: string, title: string) =>
      ipcRenderer.invoke('alerts:thread-finished', threadId, title),
  },
  sshPrompt: {
    respond: (id: string, value: string, remember = false) =>
      ipcRenderer.invoke('ssh-prompt:respond', id, value, remember),
    onRequest: (
      handler: (req: {
        id: string
        prompt: string
        kind: 'confirm' | 'secret'
        canRememberOnDevice: boolean
      }) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        req: {
          id: string
          prompt: string
          kind: 'confirm' | 'secret'
          canRememberOnDevice: boolean
        },
      ): void => {
        handler(req)
      }
      ipcRenderer.on('ssh:prompt-request', listener)
      return (): void => {
        ipcRenderer.off('ssh:prompt-request', listener)
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
      ipcRenderer.on('update:prompt-request', listener)
      return (): void => {
        ipcRenderer.off('update:prompt-request', listener)
      }
    },
    onDevNotice: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('update:dev-notice', listener)
      return (): void => {
        ipcRenderer.off('update:dev-notice', listener)
      }
    },
  },
  closeConfirm: {
    respond: (id: string, confirmed: boolean) =>
      ipcRenderer.invoke('close-confirm:respond', id, confirmed),
    onRequest: (handler: (req: { id: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, req: { id: string }): void => {
        handler(req)
      }
      ipcRenderer.on('app:close-confirm-request', listener)
      return (): void => {
        ipcRenderer.off('app:close-confirm-request', listener)
      }
    },
  },
  sshWorkspace: {
    listHosts: () => ipcRenderer.invoke('ssh-workspace:list-hosts'),
    listConfigAliases: () => ipcRenderer.invoke('ssh-workspace:list-config-aliases'),
    getStates: () => ipcRenderer.invoke('ssh-workspace:get-states'),
    listCredentialHostIds: () => ipcRenderer.invoke('ssh-workspace:list-credential-host-ids'),
    forgetCredentials: (hostId: string) =>
      ipcRenderer.invoke('ssh-workspace:forget-credentials', hostId),
    connect: (hostId: string) => ipcRenderer.invoke('ssh-workspace:connect', hostId),
    disconnect: (hostId: string) => ipcRenderer.invoke('ssh-workspace:disconnect', hostId),
    reconnect: (hostId: string) => ipcRenderer.invoke('ssh-workspace:reconnect', hostId),
    listDirectory: (hostId: string, dirPath: string) =>
      ipcRenderer.invoke('ssh-workspace:list-directory', hostId, dirPath),
    registerRoot: (hostId: string, dirPath: string) =>
      ipcRenderer.invoke('ssh-workspace:register-root', hostId, dirPath),
    onConnectionChanged: (
      handler: (states: import('@shared/types/ssh-workspace.ts').SshConnectionState[]) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        states: import('@shared/types/ssh-workspace.ts').SshConnectionState[],
      ): void => {
        handler(states)
      }
      ipcRenderer.on('ssh:connection-changed', listener)
      return (): void => {
        ipcRenderer.off('ssh:connection-changed', listener)
      }
    },
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    reload: () => ipcRenderer.invoke('mcp:reload'),
    setEnabled: (name: string, enabled: boolean) =>
      ipcRenderer.invoke('mcp:set-enabled', name, enabled),
    listCurated: () => ipcRenderer.invoke('mcp:list-curated'),
    listDeclared: () => ipcRenderer.invoke('mcp:list-declared'),
    setCuratedEnabled: (name: string, enabled: boolean) =>
      ipcRenderer.invoke('mcp:set-curated-enabled', name, enabled),
    onStatusChanged: (
      handler: (statuses: import('@shared/types/mcp.ts').McpServerStatus[]) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        statuses: import('@shared/types/mcp.ts').McpServerStatus[],
      ): void => {
        handler(statuses)
      }
      ipcRenderer.on('mcp:status-changed', listener)
      return (): void => {
        ipcRenderer.off('mcp:status-changed', listener)
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
    onShowArtefact: (
      handler: (identity: import('@shared/types/canvas.ts').CanvasArtefactIdentity) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        identity: import('@shared/types/canvas.ts').CanvasArtefactIdentity,
      ): void => {
        handler(identity)
      }
      ipcRenderer.on('canvas:show-artefact', listener)
      return (): void => {
        ipcRenderer.off('canvas:show-artefact', listener)
      }
    },
    listArtefacts: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('canvas:list-artefacts', projectId, threadId),
    reopenArtefact: (projectId: string, threadId: string, title: string) =>
      ipcRenderer.invoke('canvas:reopen-artefact', projectId, threadId, title),
  },
  storage: {
    get: (key: string) => ipcRenderer.invoke('storage:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('storage:set', key, value),
  },
  threads: {
    loadProject: (projectId: string) => ipcRenderer.invoke('threads:load-project', projectId),
    loadMessages: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('threads:load-messages', projectId, threadId),
    onPrRefs: (
      handler: (
        projectId: string,
        refs: Array<{
          threadId: string
          prRefs: import('@shared/git/github-pr-url.ts').GithubPrRef[]
        }>,
      ) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        projectId: string,
        refs: Array<{
          threadId: string
          prRefs: import('@shared/git/github-pr-url.ts').GithubPrRef[]
        }>,
      ): void => {
        handler(projectId, refs)
      }
      ipcRenderer.on('threads:pr-refs', listener)
      return (): void => {
        ipcRenderer.removeListener('threads:pr-refs', listener)
      }
    },
    create: (projectId: string, thread: import('@shared/types').Thread) =>
      ipcRenderer.invoke('threads:create', projectId, thread),
    appendMessage: (
      projectId: string,
      threadId: string,
      message: import('@shared/types').Message,
    ) => ipcRenderer.invoke('threads:append-message', projectId, threadId, message),
    updateMeta: (
      projectId: string,
      threadId: string,
      patch: Partial<Omit<import('@shared/types').Thread, 'messages'>>,
    ) => ipcRenderer.invoke('threads:update-meta', projectId, threadId, patch),
    recordModelSelection: (
      projectId: string,
      threadId: string,
      by: 'user' | 'auto',
      from: string | undefined,
      to: string,
    ) => ipcRenderer.invoke('threads:record-model-selection', projectId, threadId, by, from, to),
    delete: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('threads:delete', projectId, threadId),
    exportArchive: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('threads:export-archive', projectId, threadId),
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
    listOrphans: () => ipcRenderer.invoke('threads:list-orphans'),
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
  modelCards: {
    resolve: (modelIds: string[]) => ipcRenderer.invoke('model-cards:resolve', modelIds),
  },
  lmStudio: {
    test: (url: string, apiKey?: string) => ipcRenderer.invoke('lm-studio:test', url, apiKey),
    models: () => ipcRenderer.invoke('lm-studio:models'),
    modelInfo: () => ipcRenderer.invoke('lm-studio:model-info'),
    detect: (url?: string, apiKey?: string) => ipcRenderer.invoke('lm-studio:detect', url, apiKey),
    download: (modelId: string, url?: string, apiKey?: string) =>
      ipcRenderer.invoke('lm-studio:download', modelId, url, apiKey),
    downloadStatus: (jobId: string, url?: string, apiKey?: string) =>
      ipcRenderer.invoke('lm-studio:download-status', jobId, url, apiKey),
  },
  openRouter: {
    models: () => ipcRenderer.invoke('open-router:models'),
  },
  models: {
    bestValueDefault: () => ipcRenderer.invoke('models:best-value-default'),
    resolveDynamic: (value: string) => ipcRenderer.invoke('models:resolve-dynamic', value),
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
      ipcRenderer.on('menu:new-thread', listener)
      return (): void => {
        ipcRenderer.off('menu:new-thread', listener)
      }
    },
    onTogglePanel: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:toggle-panel', listener)
      return (): void => {
        ipcRenderer.off('menu:toggle-panel', listener)
      }
    },
    onShowExplorer: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:show-explorer', listener)
      return (): void => {
        ipcRenderer.off('menu:show-explorer', listener)
      }
    },
    onShowTerminal: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:show-terminal', listener)
      return (): void => {
        ipcRenderer.off('menu:show-terminal', listener)
      }
    },
    onShowChanges: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:show-changes', listener)
      return (): void => {
        ipcRenderer.off('menu:show-changes', listener)
      }
    },
    onShowBrowser: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:show-browser', listener)
      return (): void => {
        ipcRenderer.off('menu:show-browser', listener)
      }
    },
    onFocusBrowserUrlBar: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:focus-browser-url-bar', listener)
      return (): void => {
        ipcRenderer.off('menu:focus-browser-url-bar', listener)
      }
    },
    onKeyboardShortcuts: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:keyboard-shortcuts', listener)
      return (): void => {
        ipcRenderer.off('menu:keyboard-shortcuts', listener)
      }
    },
    onUiScaleZoomIn: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:ui-scale-zoom-in', listener)
      return (): void => {
        ipcRenderer.off('menu:ui-scale-zoom-in', listener)
      }
    },
    onUiScaleZoomOut: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:ui-scale-zoom-out', listener)
      return (): void => {
        ipcRenderer.off('menu:ui-scale-zoom-out', listener)
      }
    },
    onUiScaleReset: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('menu:ui-scale-reset', listener)
      return (): void => {
        ipcRenderer.off('menu:ui-scale-reset', listener)
      }
    },
  },
  remoteAgent: {
    downloadArtifact: (agentId: string, path: string) =>
      ipcRenderer.invoke('remote-agent:download-artifact', agentId, path),
    artifactImageDataUrl: (agentId: string, path: string) =>
      ipcRenderer.invoke('remote-agent:artifact-image-data-url', agentId, path),
    models: () => ipcRenderer.invoke('remote-agent:models'),
    /** Import outside Cursor cloud agents as local thread stubs for a project. */
    discoverExternal: (projectId?: string) =>
      ipcRenderer.invoke('remote-agent:discover-external', projectId),
  },
  acp: {
    detectAgents: () => ipcRenderer.invoke('acp:detect-agents'),
    probeAgent: (agentId: string) => ipcRenderer.invoke('acp:probe-agent', agentId),
    autoSetup: () => ipcRenderer.invoke('acp:auto-setup'),
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
    }) => ipcRenderer.invoke('settings:set-security', prefs),
    getKey: (provider: string) => ipcRenderer.invoke('settings:get-key', provider),
    getKeyEncrypted: (provider: string) =>
      ipcRenderer.invoke('settings:get-key-encrypted', provider),
    setKey: (provider: string, key: string, opts?: { allowPlaintext?: boolean }) =>
      ipcRenderer.invoke('settings:set-key', provider, key, opts),
    availableProviders: () => ipcRenderer.invoke('settings:available-providers'),
    validateKey: (provider: string, key: string) =>
      ipcRenderer.invoke('settings:validate-key', provider, key),
    scanEnvKeys: () => ipcRenderer.invoke('settings:scan-env-keys'),
    importEnvKeys: (providers?: string[]) =>
      ipcRenderer.invoke('settings:import-env-keys', providers),
    extraProviders: () => ipcRenderer.invoke('settings:extra-providers'),
    modelPricing: () => ipcRenderer.invoke('settings:model-pricing'),
    saveExtraProvider: (record: unknown) =>
      ipcRenderer.invoke('settings:save-extra-provider', record),
    deleteExtraProvider: (slug: string) =>
      ipcRenderer.invoke('settings:delete-extra-provider', slug),
    fetchProviderModels: (baseUrl: string, apiKey?: string) =>
      ipcRenderer.invoke('settings:fetch-provider-models', baseUrl, apiKey),
    refreshHuggingFaceModels: (apiKey?: string) =>
      ipcRenderer.invoke('settings:refresh-hugging-face-models', apiKey),
  },
  appIcon: {
    apply: () => ipcRenderer.invoke('app-icon:apply'),
  },
  usage: {
    getSummary: () => ipcRenderer.invoke('usage:get-summary'),
    getPlanUsage: () => ipcRenderer.invoke('usage:get-plan-usage'),
    getPlanWorthIt: () => ipcRenderer.invoke('usage:get-plan-worth-it'),
    setClaudePlanMonthlyFee: (fee: number | null) =>
      ipcRenderer.invoke('usage:set-claude-plan-monthly-fee', fee),
  },
  decisions: {
    list: (projectId?: string) => ipcRenderer.invoke('decisions:list', projectId),
    export: (projectId?: string) => ipcRenderer.invoke('decisions:export', projectId),
  },
  index: {
    query: (pattern: string) => ipcRenderer.invoke('index:query', pattern),
    resolveFileReferences: (candidates: string[]) =>
      ipcRenderer.invoke('index:resolve-file-references', candidates),
    status: () => ipcRenderer.invoke('index:status'),
    onStatusChanged: (
      handler: (status: import('@shared/types/index-status.ts').WorkspaceIndexStatus) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        status: import('@shared/types/index-status.ts').WorkspaceIndexStatus,
      ): void => {
        handler(status)
      }
      ipcRenderer.on('index:status-changed', listener)
      return (): void => {
        ipcRenderer.off('index:status-changed', listener)
      }
    },
  },
  ports: {
    list: () => ipcRenderer.invoke('ports:list'),
    kill: (port: number) => ipcRenderer.invoke('ports:kill', port),
  },
  vnc: {
    open: (target: import('@shared/types/vnc.ts').VncTarget) =>
      ipcRenderer.invoke('vnc:open', target),
    list: () => ipcRenderer.invoke('vnc:list'),
    discover: (host: import('@shared/types/vnc.ts').VncDiscoveryHost) =>
      ipcRenderer.invoke('vnc:discover', host),
    discoverNearby: () => ipcRenderer.invoke('vnc:discover-nearby'),
    resolveSshHosts: () => ipcRenderer.invoke('vnc:resolve-ssh-hosts'),
    getUsername: (target: import('@shared/types/vnc.ts').VncTarget) =>
      ipcRenderer.invoke('vnc:get-username', target),
    getPassword: (target: import('@shared/types/vnc.ts').VncTarget) =>
      ipcRenderer.invoke('vnc:get-password', target),
    hasPassword: (target: import('@shared/types/vnc.ts').VncTarget) =>
      ipcRenderer.invoke('vnc:has-password', target),
    canStoreCredentials: () => ipcRenderer.invoke('vnc:can-store-credentials'),
    rememberUsername: (target: import('@shared/types/vnc.ts').VncTarget, username: string) =>
      ipcRenderer.invoke('vnc:remember-username', target, username),
    rememberPassword: (target: import('@shared/types/vnc.ts').VncTarget, password: string) =>
      ipcRenderer.invoke('vnc:remember-password', target, password),
    forgetPassword: (target: import('@shared/types/vnc.ts').VncTarget) =>
      ipcRenderer.invoke('vnc:forget-password', target),
    forgetCredentials: (target: import('@shared/types/vnc.ts').VncTarget) =>
      ipcRenderer.invoke('vnc:forget-credentials', target),
    start: (connectionId: string): void => {
      ipcRenderer.send('vnc:start', connectionId)
    },
    send: (connectionId: string, bytes: Uint8Array): void => {
      ipcRenderer.send('vnc:send', connectionId, bytes)
    },
    close: (connectionId: string) => ipcRenderer.invoke('vnc:close', connectionId),
    onData: (handler: (connectionId: string, bytes: Uint8Array) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        connectionId: string,
        bytes: Uint8Array,
      ): void => {
        handler(connectionId, bytes)
      }
      ipcRenderer.on('vnc:data', listener)
      return (): void => {
        ipcRenderer.off('vnc:data', listener)
      }
    },
    onStatus: (handler: (event: import('@shared/types/vnc.ts').VncStatusEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        status: import('@shared/types/vnc.ts').VncStatusEvent,
      ): void => {
        handler(status)
      }
      ipcRenderer.on('vnc:status', listener)
      return (): void => {
        ipcRenderer.off('vnc:status', listener)
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
      ipcRenderer.invoke('roadmap:attachment-data', id, attachmentId),
    setStatus: (id: string, status: string) => ipcRenderer.invoke('roadmap:set-status', id, status),
    setCategory: (id: string, category: string) =>
      ipcRenderer.invoke('roadmap:set-category', id, category),
    delete: (id: string) => ipcRenderer.invoke('roadmap:delete', id),
    export: (format: string) => ipcRenderer.invoke('roadmap:export', format),
    issueUrl: (ref: string) => ipcRenderer.invoke('roadmap:issue-url', ref),
    openIssues: (page: number) => ipcRenderer.invoke('roadmap:open-issues', page),
    importIssues: (issues: { number: number; title: string; body: string }[]) =>
      ipcRenderer.invoke('roadmap:import-issues', issues),
    matchOpenIssues: (issues: { number: number; title: string; body: string }[]) =>
      ipcRenderer.invoke('roadmap:match-open-issues', issues),
    checkFit: (id: string) => ipcRenderer.invoke('roadmap:check-fit', id),
    prepareReview: () => ipcRenderer.invoke('roadmap:prepare-review'),
    lastReviewAt: () => ipcRenderer.invoke('roadmap:last-review-at'),
    reviewItem: (id: string, commits: string, runId?: string) =>
      ipcRenderer.invoke('roadmap:review-item', id, commits, runId),
    reviewItemDeep: (id: string) => ipcRenderer.invoke('roadmap:review-item-deep', id),
    completeReview: (runId: string) => ipcRenderer.invoke('roadmap:complete-review', runId),
    abortReview: (runId: string) => ipcRenderer.invoke('roadmap:abort-review', runId),
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
      ipcRenderer.invoke('roadmap:set-thread', id, threadId),
  },
  supervisor: {
    list: (projectId: string) => ipcRenderer.invoke('supervisor:list', projectId),
    cancel: (projectId: string, taskId: string) =>
      ipcRenderer.invoke('supervisor:cancel', projectId, taskId),
    onChanged: (callback: (projectId: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, projectId: string): void => {
        callback(projectId)
      }
      ipcRenderer.on('supervisor:changed', listener)
      return (): void => {
        ipcRenderer.off('supervisor:changed', listener)
      }
    },
  },
  worktrees: {
    list: (projectId: string) => ipcRenderer.invoke('worktrees:list', projectId),
    size: (projectId: string, path: string) =>
      ipcRenderer.invoke('worktrees:size', projectId, path),
    cleanupPackages: (projectId: string, path: string, remove: boolean) =>
      ipcRenderer.invoke('worktrees:cleanup-packages', projectId, path, remove),
    openTerminal: (projectId: string, path: string) =>
      ipcRenderer.invoke('worktrees:open-terminal', projectId, path),
    remove: (projectId: string, path: string, force: boolean) =>
      ipcRenderer.invoke('worktrees:remove', projectId, path, force),
  },
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
  },
  // Cursor's read-only plugin cache. Distinct from `plugins` below (the plugin
  // registry) until C1 merges the two Settings surfaces; the channel is named
  // for its source so the two cannot collide in the meantime.
  cursorPlugins: {
    list: () => ipcRenderer.invoke('cursor-plugins:list'),
  },
  hooks: {
    list: () => ipcRenderer.invoke('hooks:list'),
    test: (req: unknown) => ipcRenderer.invoke('hooks:test', req),
    runDetail: (projectId: string, threadId: string, runId: string) =>
      ipcRenderer.invoke('hooks:run-detail', projectId, threadId, runId),
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('plugins:set-enabled', id, enabled),
    setSetting: (id: string, key: string, value: unknown) =>
      ipcRenderer.invoke('plugins:set-setting', id, key, value),
    addSource: () => ipcRenderer.invoke('plugins:add-source'),
  },
  automations: {
    list: (projectId: string) => ipcRenderer.invoke('automations:list', projectId),
    upsert: (projectId: string, input: unknown) =>
      ipcRenderer.invoke('automations:upsert', projectId, input),
    remove: (projectId: string, scheduleId: string) =>
      ipcRenderer.invoke('automations:remove', projectId, scheduleId),
    runNow: (projectId: string, scheduleId: string) =>
      ipcRenderer.invoke('automations:run-now', projectId, scheduleId),
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
    read: (path: string) => ipcRenderer.invoke('instructions:read', path),
  },
  cursorRules: {
    list: () => ipcRenderer.invoke('cursor-rules:list'),
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
      ipcRenderer.invoke('terminal:set-meta', sessionId, meta),
    setActive: (sessionId: string) => ipcRenderer.invoke('terminal:set-active', sessionId),
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
      ipcRenderer.on('terminal:run-command', listener)
      return (): void => {
        ipcRenderer.off('terminal:run-command', listener)
      }
    },
  },
  git: {
    isAvailable: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:is-available', projectId, threadId),
    status: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:status', projectId, threadId),
    changeStats: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:change-stats', projectId, threadId),
    fileDiff: (projectId: string, threadId: string, path: string, staged: boolean) =>
      ipcRenderer.invoke('git:file-diff', projectId, threadId, path, staged),
    workingFileDiff: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('git:working-file-diff', projectId, threadId, path),
    committedChanges: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:committed-changes', projectId, threadId),
    committedFileDiff: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('git:committed-file-diff', projectId, threadId, path),
    branchStatus: (projectId: string, threadId: string, forBranch?: string) =>
      ipcRenderer.invoke('git:branch-status', projectId, threadId, forBranch),
    promptState: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:prompt-state', projectId, threadId),
    checkoutBranch: (projectId: string, threadId: string, branch: string) =>
      ipcRenderer.invoke('git:checkout-branch', projectId, threadId, branch),
    listBranches: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:list-branches', projectId, threadId),
    getDefaultBranch: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:get-default-branch', projectId, threadId),
    sessionBackup: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:session-backup', projectId, threadId),
    restoreBackup: (projectId: string, threadId: string) =>
      ipcRenderer.invoke('git:restore-backup', projectId, threadId),
    onWorkingTreeChanged: (handler: (root: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, root: string): void => {
        handler(root)
      }
      ipcRenderer.on('git:working-tree-changed', listener)
      return (): void => {
        ipcRenderer.off('git:working-tree-changed', listener)
      }
    },
  },
  gh: {
    status: () => ipcRenderer.invoke('gh:status'),
    invalidateReadCache: () => ipcRenderer.invoke('gh:invalidate-read-cache'),
    setListWatch: (watching: boolean, includeMyPrs: boolean) =>
      ipcRenderer.invoke('gh:set-list-watch', watching, includeMyPrs),
    onListsTick: (handler: () => void) => {
      const listener = (): void => {
        handler()
      }
      ipcRenderer.on('gh:lists-tick', listener)
      return (): void => {
        ipcRenderer.off('gh:lists-tick', listener)
      }
    },
    listMyOpenPrs: () => ipcRenderer.invoke('gh:list-my-open-prs'),
    listWorkspaceOpenPrs: () => ipcRenderer.invoke('gh:list-workspace-open-prs'),
    prChecks: (owner: string, repo: string, number: number) =>
      ipcRenderer.invoke('gh:pr-checks', owner, repo, number),
    prDetails: (owner: string, repo: string, number: number) =>
      ipcRenderer.invoke('gh:pr-details', owner, repo, number),
    prFileDiff: (owner: string, repo: string, number: number, path: string) =>
      ipcRenderer.invoke('gh:pr-file-diff', owner, repo, number, path),
    resolvePrUrl: (url: string) => ipcRenderer.invoke('gh:resolve-pr-url', url),
    agentPrLinks: () => ipcRenderer.invoke('gh:agent-pr-links'),
    rerunFailedRuns: (owner: string, repo: string, number: number) =>
      ipcRenderer.invoke('gh:rerun-failed-runs', owner, repo, number),
    approvePr: (owner: string, repo: string, number: number) =>
      ipcRenderer.invoke('gh:approve-pr', owner, repo, number),
    markPrReady: (owner: string, repo: string, number: number) =>
      ipcRenderer.invoke('gh:mark-pr-ready', owner, repo, number),
    enableAutoMerge: (owner: string, repo: string, number: number) =>
      ipcRenderer.invoke('gh:enable-auto-merge', owner, repo, number),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
    openWorkspaceFileInBrowser: (projectId: string, threadId: string, path: string) =>
      ipcRenderer.invoke('shell:open-workspace-file-in-browser', projectId, threadId, path),
  },
  editors: {
    list: () => ipcRenderer.invoke('editors:list'),
    open: (projectId: string, threadId: string, editorId: string) =>
      ipcRenderer.invoke('editors:open', projectId, threadId, editorId),
  },
  panes: {
    popout: (mode: import('@shared/types/state.ts').RightPanelMode, seed?: unknown) =>
      ipcRenderer.invoke('panes:popout', mode, seed),
    takePopoutSeed: (mode: import('@shared/types/state.ts').RightPanelMode) =>
      ipcRenderer.invoke('panes:take-popout-seed', mode),
    onSwitchMode: (
      handler: (mode: import('@shared/types/state.ts').RightPanelMode) => void,
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        mode: import('@shared/types/state.ts').RightPanelMode,
      ): void => {
        handler(mode)
      }
      ipcRenderer.on('popout:switch-mode', listener)
      return () => {
        ipcRenderer.removeListener('popout:switch-mode', listener)
      }
    },
  },
}
contextBridge.exposeInMainWorld('api', api)

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
    requestCloseConfirm() {
      return ipcRenderer.invoke('test:requestCloseConfirm')
    },
    createMainWindow() {
      return ipcRenderer.invoke('test:createMainWindow')
    },
    markQuit() {
      return ipcRenderer.invoke('test:markQuit')
    },
    openWorkspace(root: string) {
      return ipcRenderer.invoke('test:openWorkspace', root)
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
    emitApprovalRequests(requests: unknown) {
      return ipcRenderer.invoke('test:emitApprovalRequests', requests)
    },
    cancelApprovalRequest(id: string) {
      return ipcRenderer.invoke('test:cancelApprovalRequest', id)
    },
    setSemanticIndexScaleGuard(phase: 'limited' | 'skipped', reason: string) {
      return ipcRenderer.invoke('test:setSemanticIndexScaleGuard', phase, reason)
    },
    setPortRows(rows: unknown) {
      return ipcRenderer.invoke('test:setPortRows', rows)
    },
    setVncNearbyServers(servers: unknown) {
      return ipcRenderer.invoke('test:setVncNearbyServers', servers)
    },
  })
}
