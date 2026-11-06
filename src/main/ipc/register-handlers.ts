import { networkActivity } from '../services/diagnostics/network-activity.ts'
import { perfSpan, perfSyncSpan } from '../services/diagnostics/perf-trace.ts'
import { registerPlanHandlers } from './plan-handlers.ts'
import { registerChatGptPlanHandlers } from './chat-gpt-plan-handlers.ts'
import { registerClassifierHandlers } from './classifier-handlers.ts'
import { registerDecisionHandlers } from './decision-handlers.ts'
import { registerMobileHandlers } from './mobile-handlers.ts'
import { registerStorageHandlers } from './storage-handlers.ts'
import { registerUsageHandlers } from './usage-handlers.ts'
import { registerAboutHandlers } from './about-handlers.ts'
import { registerAcpHandlers } from './acp-handlers.ts'
import { registerAutomationHandlers } from './automation-handlers.ts'
import { registerEnvironmentSetupHandlers } from './environment-setup-handlers.ts'
import { registerMachineHandlers } from './machine-handlers.ts'
import { registerMcpHandlers } from './mcp-handlers.ts'
import { registerToolPermissionHandlers } from './tool-permission-handlers.ts'
import { registerAppleDevelopmentHandlers } from './apple-development-handlers.ts'
import { registerGhHandlers } from './gh-handlers.ts'
import { registerRemoteAgentHandlers } from './remote-agent-handlers.ts'
import { registerTestScenarioHandlers } from './test-scenario-handlers.ts'
import { registerGitHandlers } from './git-handlers.ts'
import { registerRoadmapHandlers } from './roadmap-handlers.ts'
import { registerMemoryHandlers } from './memory-handlers.ts'
import { registerPortHandlers } from './port-handlers.ts'
import { registerAlertHandlers } from './alert-handlers.ts'
import { registerSettingsHandlers } from './settings-handlers.ts'
import { registerPluginHandlers } from './plugin-handlers.ts'
import { registerSupervisorHandlers } from './supervisor-handlers.ts'
import { registerCustomizationHandlers } from './customization-handlers.ts'
import { registerInstructionHandlers } from './instruction-handlers.ts'
import { containerRunRequestSchema } from '@shared/container-run-schema.ts'
import { app, BrowserWindow, dialog, ipcMain, shell, webContents, type WebContents } from 'electron'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { SPINE_SCHEMA_VERSION } from '@shared/threads/spine-schema.ts'
import { scaffoldProject } from '../services/project-scaffold.ts'
import { createProcessManagerSampler } from '../services/process-manager.ts'
import { readOwnedProcessRows } from '../services/process-manager-owned.ts'
import { stopSupervisedBackgroundProcess } from '../services/exec/supervised-background-process.ts'
import { parseMessageValue, parseThreadValue } from '@shared/threads/thread-boundary.ts'
import { withoutMainOwnedThreadFields } from './thread-meta-guard.ts'
import micromatch from 'micromatch'
import { nonEmptyStringOr, recordArrayOrEmpty } from '@shared/unknown-value.ts'
import { createPanePopoutWindow } from '../windows/create-popout-window.ts'
import { broadcastToAppWindows } from '../windows/app-window-broadcast.ts'
import { browserPartitionForContents } from '../windows/browser-web-contents.ts'
import { isVisibleBrowserSessionPartition } from '@shared/browser-session.ts'
import {
  captureBrowserPageText,
  exportBrowserPageHtml,
  captureBrowserScreenshot,
  captureBrowserScrollPosition,
  exportCanvasArtefact,
  exportBrowserPagePdf,
} from '../services/browser/browser-share.ts'
import { workspacePreviewFileUrl } from '../services/browser/static-preview-server.ts'
import { takePopoutSeed } from '../services/popout-seed-store.ts'
import {
  assertAllowedWorkspaceRoot,
  getActiveProjectSshHost,
  getProjectRoot,
  getWorkspaceRoot,
  registerAllowedWorkspaceRoot,
  resolvePathWithinRoot,
  resolveSshHostForWorkspaceRoot,
  scheduleAllowedWorkspaceRootsBootstrap,
  seedAllowedWorkspaceRoots,
  workspaceProjectsToSeed,
  setWorkspaceRoot,
  type WorkspaceProjectRef,
} from '../services/workspace.ts'
import { listReadOutsideProjectGrants } from '../services/security/read-outside-grant.ts'
import { browserSessionOrigins } from '../services/browser/browser-network-grants.ts'
import { browserThreadScope } from '@shared/browser-session.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { LOOPBACK_BIND_PERMISSION } from '@copse/agent/plugins/background-tasks-plugin.ts'
import { readPendingDeferrals } from '../services/security/deferred-approval-store.ts'
import { loadCanvasArtefactSummaries, readStoredCanvasArtefact } from '../services/canvas-store.ts'
import { CANVAS_ARTEFACT_CHANNEL } from '../services/canvas-dispatch.ts'
import {
  assertFsWriteContent,
  isIndexQueryPattern,
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  zModelId,
  zNonEmptyString,
  zPathString,
  zProjectId,
  zThreadId,
  mainWindowNavigationSchema,
} from './ipc-guards.ts'
import { threadPathArgs } from './thread-path-args.ts'
import {
  resolveThreadExecutionContext,
  runWithThreadExecutionContext,
} from '../services/thread-execution-context.ts'
import { expectedThreadWorktreePath, repositoryLocation } from '../services/worktree-manager.ts'
import {
  getReadyFileIndex,
  resolveFileIndexTarget,
  whenFileIndexReady,
} from '../services/search/file-index.ts'
import { resolveFileReferences } from '../services/search/file-reference-resolver.ts'
import {
  getWorkspaceIndexStatus,
  onWorkspaceIndexStatusChanged,
} from '../services/search/index-status.ts'
import { startWorkspaceIndexing } from '../services/search/workspace-indexing.ts'
import { scheduleIndexRebuild } from '../services/search/workspace-index-watcher.ts'
import { getSetting } from '../services/storage/settings.ts'
import { createElectronUserAlertSender } from '../services/user-alerts-electron.ts'
import { storageGet } from '../services/storage/storage.ts'
import {
  getMainWindowBrowserSession,
  getMainWindowForWebContents,
  getMainWindowNavigation,
  setMainWindowBrowserSession,
  setMainWindowNavigation,
} from '../windows/create-main-window.ts'
import { browserPaneSessionSchema, decodeBrowserPaneSession } from '../windows/main-window-state.ts'
import {
  searchThreadRequests,
  cancelThreadRequestSearch,
  warmThreadRequestSearch,
} from '../services/thread-request-search.ts'
import {
  measureThreadStorage,
  backfillThreadPrRefs,
  getLatestThreadPlan,
  loadProjectThreadMetas,
  loadThreadMessages,
  createThread,
  appendMessage,
  updateMeta,
  recordModelSelection,
  loadProjectCatalog,
  listOrphanProjectStores,
} from '../services/thread-store.ts'
import {
  deleteThreadResourcesAndStore,
  type ThreadDeletionRuntime,
} from '../services/thread-deletion.ts'
import { buildThreadArchive } from '../services/thread-archive.ts'
import { archiveStoredThread, type ThreadArchivingRuntime } from '../services/thread-archiving.ts'
import { ThreadAutoArchive } from '../services/thread-auto-archive.ts'
import {
  getElectronAppVersion,
  getElectronBuildCommit,
  getElectronBuildDirty,
  isElectronAppPackaged,
} from '../services/electron-app-runtime.ts'
import {
  describeWorkspaceArchive,
  storeArchiveAttachment,
} from '../services/archive/archive-attachment-store.ts'
import {
  describeWorkspaceVideo,
  storeVideoAttachment,
  readVideoForPlayback,
} from '../services/video/video-attachment-store.ts'
import { forkThreadHistory } from '../services/thread-fork.ts'
import {
  applyThreadHistoryEdit,
  loadThreadHistorySnapshot,
  undoThreadHistoryEdit,
  type ThreadHistoryEditRuntime,
} from '../services/thread-history-edit.ts'
import {
  listExternalEditors,
  openWorkspaceInExternalEditor,
} from '../services/editors/editor-launcher.ts'
import { listRunningThreadIds } from '../services/agent-service.ts'
import {
  listWorktreeInventory,
  cleanupWorktreePackages,
  measureWorktreeSize,
  removeWorktree,
  resolveRegisteredWorktreePath,
} from '../services/worktree-inventory.ts'
import { revalidateStaleAcpModels, runAcpAutoSetup } from '../services/acp/acp-auto-setup.ts'
import { getSshConnectionManager } from '../services/ssh-workspace/connection-manager.ts'
import { WorkspaceActivation } from '../services/workspace-activation.ts'
import { prepareWorkspaceConnection } from '../services/workspace-connection.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'
import { initSkillsRegistry } from '../services/skills/skills-registry.ts'
import { initAgentsRegistry } from '../services/agents/agents-registry.ts'
import { getPluginService } from '../services/plugins/plugin-service.ts'
import {
  setPluginToolRuntimeController,
  ToolingPluginToolRuntimeController,
} from '../services/plugins/plugin-tool-controller.ts'
import { createPluginBrowserPanelService } from '../services/plugins/plugin-browser-panel.ts'
import { setPluginBrowserService } from '../services/plugins/plugin-browser-service.ts'
import { registerSkillTools } from '../services/registry-bootstrap.ts'

import { setGitHubListWatchBroadcast } from '../services/github/backend/github-list-watch.ts'
import { reloadMcpServers, setWorkspaceTrustAndReload } from '../services/mcp/mcp-registry.ts'
import { isWorkspaceTrusted } from '../services/security/workspace-trust.ts'
import { getFocusedMainWindow, syncDevtoolsShortcut } from '../windows/create-main-window.ts'
import { lookupThreadBacklinks } from '../services/thread-store.ts'

import {
  gatewayListDir,
  gatewayReadFile,
  gatewayReadImage,
  gatewayReaddir,
  gatewayWriteFile,
} from '../project-sandbox/sandbox-fs-client.ts'
import { requestApproval } from '../services/approval.ts'
import {
  armGuardedYolo,
  disableGuardedYolo,
  getGuardedYoloState,
  onGuardedYoloChanged,
} from '../services/security/guarded-yolo.ts'
import { getContainerRunService } from '../services/container-runtime/container-run-service.ts'
import { explainContainerModel } from '../services/providers/container-provider.ts'

function storedWorkspaceProjects(): WorkspaceProjectRef[] {
  return recordArrayOrEmpty(storageGet('projects')).flatMap((project) => {
    const path = project['path']
    const sshHost = project['sshHost']
    if (typeof path !== 'string') return []
    return [typeof sshHost === 'string' ? { path, sshHost } : { path }]
  })
}

function processManagerLabels(): Map<number, string> {
  const labels = new Map<number, string>()
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    const pid = window.webContents.getOSProcessId()
    if (pid > 0) labels.set(pid, 'Copse window')
  }

  const pages = new Map<number, string[]>()
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed() || contents.getType() !== 'webview') continue
    const pid = contents.getOSProcessId()
    if (pid <= 0) continue
    const titles = pages.get(pid) ?? []
    const title = contents.getTitle().trim()
    titles.push(title.length > 0 ? title : 'Untitled page')
    pages.set(pid, titles)
  }
  for (const [pid, titles] of pages) {
    labels.set(
      pid,
      titles.length === 1
        ? `Browser: ${titles[0] ?? 'Untitled page'}`
        : `Browser pages (${String(titles.length)})`,
    )
  }
  return labels
}

export function registerAllHandlers(
  win: BrowserWindow,
  registry: ToolRegistry,
  isDispatcherThreadActive: (projectId: string, threadId: string) => boolean,
  threadDeletionRuntime: ThreadDeletionRuntime,
  threadHistoryEditRuntime: ThreadHistoryEditRuntime,
  threadArchivingRuntime: ThreadArchivingRuntime,
): void {
  const autoArchive = new ThreadAutoArchive({
    ...threadArchivingRuntime,
    isViewed: (projectId, threadId): boolean =>
      BrowserWindow.getAllWindows().some((window) => {
        if (!getMainWindowForWebContents(window.webContents)) return false
        const navigation = getMainWindowNavigation(window.webContents)
        return navigation.activeProjectId === projectId && navigation.activeThreadId === threadId
      }),
  })
  const notifyAutoArchive = (
    event: import('@shared/threads/auto-archive.ts').ThreadAutoArchived,
  ): void => {
    if (!win.isDestroyed()) win.webContents.send('threads:auto-archived', event)
  }
  const sweepArchives = (): void => {
    const ids = recordArrayOrEmpty(storageGet('projects')).flatMap((project) =>
      typeof project['id'] === 'string' && !project['sshHost'] ? [project['id']] : [],
    )
    void autoArchive.sweep(ids, notifyAutoArchive).catch((error: unknown) => {
      console.warn('[auto-archive]', error)
    })
  }
  const archiveStartup = setTimeout(sweepArchives, 60_000)
  const archiveInterval = setInterval(sweepArchives, 60 * 60_000)
  archiveStartup.unref()
  archiveInterval.unref()
  win.once('closed', () => {
    clearTimeout(archiveStartup)
    clearInterval(archiveInterval)
  })

  registerMobileHandlers(win)

  // Read once: Electron throws on `win.webContents` after the boot window is
  // closed, and a second main window can outlive it.
  const primaryWebContentsId = win.webContents.id

  // Reserve container starts before asynchronous preflight, so plan writes and
  // container launches cannot pass each other's idle check.
  const startingContainerThreads = new Set<string>()
  registerPlanHandlers(
    win,
    (projectId, threadId) =>
      isDispatcherThreadActive(projectId, threadId) ||
      listRunningThreadIds().includes(threadId) ||
      startingContainerThreads.has(threadId) ||
      getContainerRunService().isActive(threadId),
  )
  const processManagerSnapshot = createProcessManagerSampler(
    () => app.getAppMetrics(),
    processManagerLabels,
    (appPids) => readOwnedProcessRows(primaryWebContentsId, appPids),
  )
  const reloadMcpForWorkspace = (): void => {
    void reloadMcpServers(registry)
      .then((statuses) => {
        broadcastToAppWindows('mcp:status-changed', statuses)
      })
      .catch((err: unknown) => {
        console.error('[mcp] workspace reload failed:', err)
      })
  }

  setGitHubListWatchBroadcast(() => {
    broadcastToAppWindows('gh:lists-tick')
  })
  const alertUser = createElectronUserAlertSender(win, app.dock, getFocusedMainWindow)
  const pluginService = getPluginService()
  setPluginBrowserService(createPluginBrowserPanelService(win))
  setPluginToolRuntimeController(new ToolingPluginToolRuntimeController(registry))
  void pluginService
    .refreshInstalledPlugins()
    // The first startup pass may have run before this handler installed the
    // selected-plugin runtime controller. Reconcile selected sources once more
    // so their behavior starts after the controller is available.
    .then(() => pluginService.refreshPluginSources())
    .catch((error: unknown) => {
      console.warn('[plugins] startup reconciliation failed:', error)
    })
  // Register the DevTools shortcut at boot iff the `copse.devtools-shortcut`
  // plugin is enabled. The plugin ships off (`defaultEnabled: false`) and
  // getPluginService() has already layered the user's explicit choices on top, so
  // this is a no-op unless they opted in.
  syncDevtoolsShortcut()
  const stopGuardedYoloEvents = onGuardedYoloChanged((threadId) => {
    if (!win.isDestroyed()) {
      win.webContents.send('security:guarded-yolo-changed', getGuardedYoloState(threadId))
    }
  })
  win.once('closed', stopGuardedYoloEvents)
  const stopContainerRunEvents = getContainerRunService().onChanged((progress) => {
    if (!win.isDestroyed()) win.webContents.send('container:run-changed', progress)
  })
  win.once('closed', stopContainerRunEvents)
  // Containers and workspace volumes from runs the previous session quit on.
  void getContainerRunService().sweepOrphans()
  const storedProjects = storedWorkspaceProjects()
  scheduleAllowedWorkspaceRootsBootstrap(async () => {
    await seedAllowedWorkspaceRoots(storedProjects)
    const persistedRoot = getWorkspaceRoot()
    if (persistedRoot) {
      const sshHost = getActiveProjectSshHost()
      try {
        await registerAllowedWorkspaceRoot(persistedRoot, sshHost)
      } catch {
        // Stale workspaceRoot in config — ignore until user picks a folder.
      }
    }
  })

  ipcMain.handle('process-manager:snapshot', async (event) => {
    assertMainFrameSender(event, win)
    const snapshot = await processManagerSnapshot()
    return { ...snapshot, network: networkActivity.snapshot() }
  })

  ipcMain.handle('process-manager:stop-background', (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    if (!getMainWindowForWebContents(event.sender)) {
      throw new IpcValidationError('Only a main window can stop a background task')
    }
    const [id, projectId, threadId] = parseIpcArgs(
      z.tuple([z.string().min(1).max(128), zProjectId, zThreadId]),
      rawArgs,
    )
    return stopSupervisedBackgroundProcess(id, { projectId, threadId })
  })

  ipcMain.handle('main-window:get-navigation', (event) => {
    assertMainFrameSender(event, win)
    return getMainWindowNavigation(event.sender)
  })

  ipcMain.handle('main-window:set-navigation', (event, rawNavigation: unknown) => {
    assertMainFrameSender(event, win)
    const navigation = parseIpcArgs(mainWindowNavigationSchema, [rawNavigation])
    setMainWindowNavigation(event.sender, navigation)
  })

  // The Browser pane's tabs, so quitting no longer throws away the canvas the
  // agent rendered. Stored per window beside its navigation and bounded by the
  // same schema the launch-time decode uses.
  ipcMain.handle('main-window:get-browser-session', (event) => {
    assertMainFrameSender(event, win)
    return getMainWindowBrowserSession(event.sender)
  })

  ipcMain.handle('main-window:set-browser-session', (event, rawSession: unknown) => {
    assertMainFrameSender(event, win)
    const session = parseIpcArgs(browserPaneSessionSchema, [rawSession])
    setMainWindowBrowserSession(event.sender, decodeBrowserPaneSession(session))
  })

  ipcMain.handle('workspace:open', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    const root = await registerAllowedWorkspaceRoot(result.filePaths[0])
    setWorkspaceRoot(root)
    reloadMcpForWorkspace()
    // Scheduled, not awaited — index builds must not block the renderer's
    // swap to the full layout; the footer indicator reports progress.
    startWorkspaceIndexing(root, { kind: 'local' })
    await initSkillsRegistry()
    await initAgentsRegistry()
    registerSkillTools(registry)
    return root
  })

  // Create a brand-new project folder under a user-chosen parent directory:
  // mkdir the folder, write starter AGENT.md + README.md, `git init` it, and
  // register it through the same allowed-root trust boundary as Open Folder.
  // Returns the canonical new path, or null if the parent was cancelled.
  // The user's home directory, used to default the New project dialog's parent
  // when no prior local project gives a better guess. Treated as a data value
  // (not a workspace root), so it is never registered as allowed.
  ipcMain.handle('workspace:get-home-directory', (event) => {
    assertMainFrameSender(event, win)
    return homedir()
  })

  // Parent-directory picker for the "New project" dialog's Browse button. This
  // is a bare pick — it does NOT register the chosen folder as a workspace root
  // (the project folder created under it is registered by `workspace:create-project`).
  ipcMain.handle('workspace:pick-parent-directory', async (event) => {
    assertMainFrameSender(event, win)
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a parent directory for the new project',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  // Create a brand-new project folder under a caller-chosen parent directory:
  // mkdir the folder, write starter AGENT.md + README.md, `git init` it, and
  // register it through the same allowed-root trust boundary as Open Folder.
  ipcMain.handle(
    'workspace:create-project',
    async (event, rawName: unknown, rawParent: unknown) => {
      assertMainFrameSender(event, win)
      const name = parseIpcArgs(z.string().trim().min(1).max(200), [rawName])
      const parentDir = parseIpcArgs(zPathString, [rawParent])
      const projectPath = join(parentDir, name)
      // Never escape the chosen parent (a crafted name like `..` must not climb).
      if (resolve(parentDir, name) !== projectPath || basename(projectPath) !== name) {
        throw new IpcValidationError('Invalid project name')
      }
      let projectMissing = false
      try {
        const existing = await stat(projectPath)
        if (!existing.isDirectory())
          throw new IpcValidationError('Target exists and is not a folder')
        const entries = await readdir(projectPath)
        if (entries.length > 0)
          throw new IpcValidationError('Folder already exists and is not empty')
      } catch (err) {
        // ENOENT means the folder does not exist yet — scaffolding proceeds below.
        if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        projectMissing = true
      }
      if (projectMissing) await mkdir(projectPath, { recursive: true })
      await scaffoldProject(projectPath, name, projectMissing)
      const root = await registerAllowedWorkspaceRoot(projectPath)
      return root
    },
  )

  ipcMain.handle('workspace:get', () => getWorkspaceRoot())

  function interactiveBrowserContents(
    event: Electron.IpcMainInvokeEvent,
    rawId: unknown,
  ): WebContents {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(z.number().int().positive(), [rawId])
    const contents = webContents.fromId(id)
    const partition = contents ? browserPartitionForContents(contents) : undefined
    if (
      !contents ||
      contents.isDestroyed() ||
      // The guest must belong to the window asking: the main window, a second
      // main window, or the pane pop-out — never another window's tab.
      contents.hostWebContents !== event.sender ||
      !partition ||
      !isVisibleBrowserSessionPartition(partition)
    ) {
      throw new IpcValidationError('Browser sharing rejected: unknown interactive browser tab')
    }
    return contents
  }

  ipcMain.handle('browser:share-page-text', async (event, rawId: unknown) => {
    const share = await captureBrowserPageText(interactiveBrowserContents(event, rawId))
    if (!event.sender.isDestroyed()) event.sender.send('browser:share-text', share)
  })

  ipcMain.handle('browser:share-screenshot', async (event, rawId: unknown) => {
    const share = await captureBrowserScreenshot(interactiveBrowserContents(event, rawId))
    if (!event.sender.isDestroyed()) event.sender.send('browser:share-image', share)
  })

  ipcMain.handle('browser:capture-screenshot', async (event, rawId: unknown) => {
    return await captureBrowserScreenshot(interactiveBrowserContents(event, rawId))
  })

  ipcMain.handle('browser:scroll-position', async (event, rawId: unknown) => {
    return await captureBrowserScrollPosition(interactiveBrowserContents(event, rawId))
  })

  ipcMain.handle('browser:export-pdf', async (event, rawId: unknown) => {
    const contents = interactiveBrowserContents(event, rawId)
    return await exportBrowserPagePdf(
      contents,
      async (defaultFilename) => {
        const result = await dialog.showSaveDialog(win, {
          title: 'Export PDF',
          defaultPath: defaultFilename,
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        })
        return result.canceled || !result.filePath ? null : result.filePath
      },
      async (filePath, data) => {
        await writeFile(filePath, data)
      },
    )
  })

  ipcMain.handle('browser:export-page', async (event, rawId: unknown) => {
    const contents = interactiveBrowserContents(event, rawId)
    return await exportBrowserPageHtml(
      contents,
      async (defaultFilename) => {
        const result = await dialog.showSaveDialog(win, {
          title: 'Download page',
          defaultPath: defaultFilename,
          filters: [{ name: 'HTML document', extensions: ['html'] }],
        })
        return result.canceled || !result.filePath ? null : result.filePath
      },
      async (filePath, body) => {
        await writeFile(filePath, body, 'utf8')
      },
    )
  })

  ipcMain.handle('browser:export-artefact', async (event, rawArtefact: unknown) => {
    assertMainFrameSender(event, win)
    const artefact = parseIpcArgs(
      z.strictObject({
        title: z.string().trim().min(1).max(200),
        mimeType: z.literal('text/html'),
        body: z
          .string()
          .min(1)
          .max(512 * 1024),
      }),
      [rawArtefact],
    )
    return await exportCanvasArtefact(
      artefact,
      async (defaultFilename) => {
        const result = await dialog.showSaveDialog(win, {
          title: 'Download canvas',
          defaultPath: defaultFilename,
          filters: [{ name: 'HTML document', extensions: ['html'] }],
        })
        return result.canceled || !result.filePath ? null : result.filePath
      },
      async (filePath, body) => {
        await writeFile(filePath, body, 'utf8')
      },
    )
  })

  const workspaceActivations = new WeakMap<WebContents, WorkspaceActivation>()
  ipcMain.handle('workspace:set', async (event, root: unknown, sshHostArg?: unknown) => {
    assertMainFrameSender(event, win)
    const parsedRoot = parseIpcArgs(zPathString, [root])
    const explicitSshHost = parseIpcArgs(z.string().max(128).optional(), [sshHostArg])
    let activation = workspaceActivations.get(event.sender)
    if (!activation) {
      activation = new WorkspaceActivation()
      workspaceActivations.set(event.sender, activation)
    }
    const assertCurrentSelection = activation.begin()
    // Each phase is timed separately (COPSE_PERF=1) so a slow switch names the
    // phase, and `loop:stall` records show which of them held the event loop.
    const projects = perfSyncSpan('workspace-set:read-projects', storedWorkspaceProjects)
    const sshHost = perfSyncSpan('workspace-set:resolve-ssh', () =>
      resolveSshHostForWorkspaceRoot(parsedRoot, explicitSshHost),
    )
    await perfSpan(
      'workspace-set:seed',
      () => seedAllowedWorkspaceRoots(workspaceProjectsToSeed(projects, parsedRoot, sshHost)),
      { projects: projects.length },
    )
    assertCurrentSelection()
    const canonical = await perfSpan('workspace-set:assert', () =>
      assertAllowedWorkspaceRoot(parsedRoot, sshHost),
    )
    assertCurrentSelection()
    if (sshHost) {
      const connections = getSshConnectionManager()
      await prepareWorkspaceConnection({
        enabled: getSetting('sshWorkspaceEnabled', false),
        connected: connections.getConnection(sshHost) !== null,
        connect: () => connections.connect(sshHost),
      })
    }
    assertCurrentSelection()
    perfSyncSpan('workspace-set:set-root', () => {
      setWorkspaceRoot(canonical)
    })
    perfSyncSpan('workspace-set:mcp-reload', reloadMcpForWorkspace)
    perfSyncSpan('workspace-set:start-indexing', () => {
      startWorkspaceIndexing(
        canonical,
        sshHost ? { kind: 'ssh', hostId: sshHost, remoteRoot: canonical } : { kind: 'local' },
      )
    })
    // Do NOT block the IPC response (and therefore the renderer's boot / first
    // paint) on the skills scan. It re-scans user + bundled + workspace skill
    // roots and, when the workspace index build is churning the event loop, can
    // take many seconds — which left the UI stuck on "loading" because
    // `api.workspace.set` never returned. Populate skills in the background and
    // register their tools when ready; the window renders immediately.
    void initSkillsRegistry()
      .then(() => {
        registerSkillTools(registry)
      })
      .catch((err: unknown) => {
        console.warn('[skills] background init failed:', err)
      })
    void initAgentsRegistry().catch((err: unknown) => {
      console.warn('[agents] background init failed:', err)
    })
    // Now a workspace is available, refresh any ACP model caches that have aged
    // past the TTL. Fire-and-forget: the picker reads settings live, so fresh
    // models (e.g. a new Opus release) appear on its next open without blocking
    // boot or requiring a manual "Detect models".
    revalidateStaleAcpModels()
    // Register any already-installed ACP presets so a detected agent (e.g.
    // `claude`, `codex` on PATH) lands in the model picker without the user
    // having to open Settings → ACP agents first. Fire-and-forget for the same
    // reason as above; registering a preset with no package to install never
    // shows an approval dialog, so this stays silent in the common case. Skipped
    // under the e2e harness: specs seed `registeredAcpAgents` explicitly, and
    // this would otherwise pick up whatever ACP CLIs happen to be on the
    // developer's own PATH.
    if (process.env['COPSE_E2E'] !== '1') {
      void runAcpAutoSetup(new AbortController().signal).catch((err: unknown) => {
        console.warn('[acp] auto-setup on workspace open failed:', err)
      })
    }
    return canonical
  })

  ipcMain.handle('fs:read-file', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(threadPathArgs, rawArgs)
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    const abs = await resolvePathWithinRoot(relPath, root)
    return gatewayReadFile(abs, root)
  })

  ipcMain.handle('fs:read-image', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(threadPathArgs, rawArgs)
    // Missing or oversized previews are routine (a thread can outlive its worktree
    // files), so report them as data; a rejected handler makes Electron log a stack.
    try {
      const { root } = await resolveThreadExecutionContext(projectId, threadId)
      const abs = await resolvePathWithinRoot(relPath, root)
      return { ok: true, data: await gatewayReadImage(abs, root, relPath) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('fs:write-file', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath, content] = parseIpcArgs(
      z.tuple([zProjectId, zThreadId, zPathString, z.string()]),
      rawArgs,
    )
    assertFsWriteContent(content)
    const context = await resolveThreadExecutionContext(projectId, threadId)
    const abs = await resolvePathWithinRoot(relPath, context.root)
    await gatewayWriteFile(abs, content, context.root)
    runWithThreadExecutionContext(context, () => {
      scheduleIndexRebuild(context.root)
    })
  })

  ipcMain.handle('fs:readdir', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(threadPathArgs, rawArgs)
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    const abs = await resolvePathWithinRoot(relPath, root)
    return gatewayReaddir(abs, root)
  })

  ipcMain.handle('fs:list-dir', async (event, projectIdArg, threadIdArg, pathArg) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(
      z.tuple([zProjectId, zThreadId, zPathString.optional()]),
      [projectIdArg, threadIdArg, pathArg],
    )
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    const abs = await resolvePathWithinRoot(nonEmptyStringOr(relPath, '.'), root)
    const dirents = await gatewayListDir(abs, root)
    return dirents
      .filter((d) => !d.name.startsWith('.') && d.name !== 'node_modules')
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  })

  ipcMain.handle('index:query', async (event, pattern: unknown) => {
    assertMainFrameSender(event, win)
    if (pattern !== undefined && typeof pattern !== 'string') {
      throw new IpcValidationError('Index query pattern must be a string')
    }
    const query = typeof pattern === 'string' ? pattern : ''
    if (query && !isIndexQueryPattern(query)) return []
    // Renderer-global feature (command palette / `@` mention picker), scoped
    // to the renderer-selected workspace root, not any one thread's execution root.
    const root = getWorkspaceRoot()
    if (!root) return []
    const idx = await getReadyFileIndex(root)
    if (!idx) return []
    return query ? micromatch(idx.paths, `**/*${query}*`).slice(0, 20) : idx.paths.slice(0, 20)
  })

  ipcMain.handle('index:status', (event) => {
    assertMainFrameSender(event, win)
    return getWorkspaceIndexStatus()
  })

  onWorkspaceIndexStatusChanged((status) => {
    if (!win.isDestroyed()) win.webContents.send('index:status-changed', status)
  })

  ipcMain.handle(
    'index:resolve-file-references',
    async (event, rawCandidates: unknown, rawOwner: unknown) => {
      assertMainFrameSender(event, win)
      const [candidates, owner] = parseIpcArgs(
        z.tuple([
          z.array(z.string().min(1).max(4096)).max(200),
          z.object({ projectId: zProjectId, threadId: zThreadId }).strict().optional(),
        ]),
        [rawCandidates, rawOwner],
      )
      if (!owner) {
        const root = getWorkspaceRoot()
        const target = resolveFileIndexTarget()
        if (root) await whenFileIndexReady(root, target)
        return await resolveFileReferences(candidates, root, undefined, target)
      }
      const context = await resolveThreadExecutionContext(owner.projectId, owner.threadId)
      return runWithThreadExecutionContext(context, async () => {
        const root = context.root
        await whenFileIndexReady(root)

        const currentWorktreePath = expectedThreadWorktreePath(owner.projectId, owner.threadId)
        let projectRelativePath = relative(currentWorktreePath, context.root)
        if (context.checkoutMode === 'shared') {
          try {
            ;({ projectRelativePath } = await repositoryLocation(context.projectRoot))
          } catch {
            // Non-Git projects still support root-relative links.
            projectRelativePath = ''
          }
        }
        return await resolveFileReferences(candidates, root, {
          projectRoot: context.projectRoot,
          managedProjectRoot: dirname(currentWorktreePath),
          projectRelativePath,
        })
      })
    },
  )

  registerPortHandlers(win)

  registerMemoryHandlers(win)

  registerRoadmapHandlers(win)

  registerMachineHandlers(win)

  registerClassifierHandlers(win)

  registerEnvironmentSetupHandlers(win)

  registerChatGptPlanHandlers(win)

  registerAlertHandlers(win, alertUser)

  registerSettingsHandlers(win, registry)
  registerUsageHandlers(win)
  registerDecisionHandlers(win)
  registerStorageHandlers(win)

  const zGuardedYoloThreadId = zNonEmptyString.max(256)
  ipcMain.handle('security:get-guarded-yolo', (event, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zGuardedYoloThreadId, [threadId])
    return getGuardedYoloState(id)
  })
  ipcMain.handle(
    'security:get-context-permissions',
    (event, projectId: unknown, threadId: unknown, projectRoot: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, root] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, zNonEmptyString.max(4096)]),
        [projectId, threadId, projectRoot],
      )
      return {
        outsideReadPaths: listReadOutsideProjectGrants(tid),
        browserOrigins: browserSessionOrigins(browserThreadScope(pid, tid)),
        portBindingAllowed:
          getDefaultPluginRegistry().isPermissionDeclared(LOOPBACK_BIND_PERMISSION) &&
          getSetting<string[]>('portBindingAllowedRoots', []).includes(root),
      }
    },
  )
  ipcMain.handle('security:enable-guarded-yolo', async (event, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zGuardedYoloThreadId, [threadId])
    const current = getGuardedYoloState(id)
    if (current.phase !== 'off') return current
    const containment =
      current.containment === 'project-sandbox'
        ? 'The project sandbox remains in use where possible. Outside-project reads of non-credential paths auto-run inside a widened seatbelt; other external commands may run unsandboxed.'
        : 'No OS sandbox is active on this platform, so commands run with your full user permissions. Outside-project reads of non-credential paths still auto-run; credential paths and home-root listings stay refused.'
    const { approved } = await requestApproval({
      title: 'Enable Guarded YOLO for this thread?',
      cause: 'mode-arming',
      body: [
        'Routine shell commands will run without approval in this thread, including outside-project reads of non-credential paths.',
        '',
        containment,
        '',
        'GitHub CLI writes (for example `gh pr create`) still require confirmation. Credential files, `~`, and `/` remain refused.',
        '',
        'A deterministic host-owned checker will still ask about bounded destructive work and permanently block obvious catastrophic commands. It reduces obvious harm, but it is not a complete security boundary and cannot understand every script or obfuscation.',
        '',
        'Guarded YOLO stays enabled for this thread until you disable it or restart the app.',
      ].join('\n'),
      type: 'shell',
      allowRemember: false,
    })
    if (approved) armGuardedYolo(id)
    return getGuardedYoloState(id)
  })
  ipcMain.handle('security:disable-guarded-yolo', (event, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zGuardedYoloThreadId, [threadId])
    disableGuardedYolo(id)
    return getGuardedYoloState(id)
  })

  // Unattended container runs (docs/plans/thread-in-container.md). The
  // renderer sends the prompt, the model and the budgets; the main process
  // resolves the checkout, the provider and its key, and owns the run.
  ipcMain.handle('container:run-thread', async (event, request: unknown) => {
    assertMainFrameSender(event, win)
    const parsed = parseIpcArgs(containerRunRequestSchema, [request])
    const [projectId, threadId] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [
      parsed.projectId,
      parsed.threadId,
    ])
    if (startingContainerThreads.has(threadId))
      throw new Error('A container run is already starting')
    startingContainerThreads.add(threadId)
    try {
      const activePlan = await getLatestThreadPlan(projectId, threadId)
      if (activePlan && activePlan.meta.status !== 'abandoned') {
        throw new Error(
          'Container runs cannot enforce the plan workflow. End the plan before starting a container run.',
        )
      }
      return await getContainerRunService().start({
        projectId,
        threadId,
        prompt: parsed.prompt,
        model: parsed.model,
        budgets: parsed.budgets,
        ...(parsed.useAgentLogin !== undefined ? { useAgentLogin: parsed.useAgentLogin } : {}),
        ...(parsed.installDependencies !== undefined
          ? { installDependencies: parsed.installDependencies }
          : {}),
        ...(parsed.continueFrom !== undefined ? { continueFrom: parsed.continueFrom } : {}),
        ...(parsed.continueContext !== undefined
          ? { continueContext: parsed.continueContext }
          : {}),
      })
    } finally {
      startingContainerThreads.delete(threadId)
    }
  })
  // Why each model could not run in a container, or null when it could — the
  // resolver's own answer, so the dialog's greyed rows never disagree with a
  // refused start about which key counts (Settings or the environment).
  ipcMain.handle('container:model-availability', async (event, models: unknown) => {
    assertMainFrameSender(event, win)
    const list = parseIpcArgs(z.array(zNonEmptyString.max(256)).max(512), [models])
    const verdicts = await Promise.all(list.map((model) => explainContainerModel(model)))
    return Object.fromEntries(list.map((model, index) => [model, verdicts[index]]))
  })
  ipcMain.handle('container:get-run', (event, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zGuardedYoloThreadId, [threadId])
    return getContainerRunService().get(id)
  })
  ipcMain.handle('container:stop-run', (event, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zGuardedYoloThreadId, [threadId])
    return getContainerRunService().stop(id)
  })
  // Follow up on a finished run: its commits, cherry-picked onto the thread's
  // checkout. The runtime id names the record on disk, so it works for a run
  // an earlier app session made; the thread must be the one that ran it.
  ipcMain.handle(
    'container:adopt-run',
    (event, projectId: unknown, threadId: unknown, runtimeId: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, rid] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.string().regex(/^[a-z0-9-]{1,128}$/i)]),
        [projectId, threadId, runtimeId],
      )
      return getContainerRunService().adopt(pid, tid, rid)
    },
  )
  ipcMain.handle('threads:storage-size', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, tid] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return measureThreadStorage(pid, tid)
  })
  ipcMain.handle('threads:load-project', (event, projectId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zProjectId, [projectId])
    // Archived threads stay on disk but are hidden from renderer surfaces.
    // The sidebar loads metadata only; legacy PR links are filled on demand
    // when their rows enter the visible viewport.
    return loadProjectThreadMetas(id, { includeArchived: false }).then((threads) => {
      warmThreadRequestSearch(id)
      return threads
    })
  })
  ipcMain.handle('threads:archive-state', async (event, projectId: unknown, view: unknown) => {
    assertMainFrameSender(event, win)
    const [id, mode] = parseIpcArgs(z.tuple([zProjectId, z.enum(['review', 'archived'])]), [
      projectId,
      view,
    ])
    if (mode === 'review') await autoArchive.sweep([id], notifyAutoArchive, false)
    const threads = mode === 'archived' ? await loadProjectThreadMetas(id) : []
    return {
      archived: threads.filter((thread) => thread.archivedAt != null && !thread.sideChat),
      review: autoArchive.review(id),
    }
  })
  ipcMain.handle(
    'threads:archive-decision',
    (event, projectId: unknown, threadId: unknown, decision: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, action] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.enum(['archive', 'keep', 'restore'])]),
        [projectId, threadId, decision],
      )
      return autoArchive.decide(pid, tid, action)
    },
  )
  ipcMain.handle('threads:backfill-pr-refs', async (event, projectId: unknown, ids: unknown) => {
    assertMainFrameSender(event, win)
    const [id, threadIds] = parseIpcArgs(z.tuple([zProjectId, z.array(zThreadId).min(1).max(10)]), [
      projectId,
      ids,
    ])
    await backfillThreadPrRefs(id, threadIds, (refs) => {
      if (!win.isDestroyed()) win.webContents.send('threads:pr-refs', id, refs)
    })
  })
  // PROTOTYPE (lazy thread loading): fetch one thread's transcript on demand,
  // when the user actually opens it.
  ipcMain.handle('threads:search-requests', (event, projectId: unknown, query: unknown) => {
    assertMainFrameSender(event, win)
    const [id, text] = parseIpcArgs(z.tuple([zProjectId, z.string().max(4096)]), [projectId, query])
    return searchThreadRequests(id, text)
  })
  ipcMain.handle('threads:cancel-request-search', (event) => {
    assertMainFrameSender(event, win)
    cancelThreadRequestSearch()
  })
  ipcMain.handle('threads:load-messages', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [id, thread] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return loadThreadMessages(id, thread)
  })
  // Canvas artefacts saved by earlier sessions. The renderer holds artefacts
  // only as live tabs and an in-memory thumbnail map, so after a restart these
  // two are the only way back to something the agent rendered yesterday.
  ipcMain.handle('canvas:list-artefacts', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [id, thread] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return loadCanvasArtefactSummaries(id, thread)
  })
  ipcMain.handle(
    'canvas:read-artefact',
    (event, projectId: unknown, threadId: unknown, title: unknown) => {
      assertMainFrameSender(event, win)
      const [id, thread, name] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.string().trim().min(1).max(200)]),
        [projectId, threadId, title],
      )
      return readStoredCanvasArtefact(id, thread, name)
    },
  )
  ipcMain.handle(
    'canvas:reopen-artefact',
    async (event, projectId: unknown, threadId: unknown, title: unknown) => {
      assertMainFrameSender(event, win)
      const [id, thread, name] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.string().trim().min(1).max(200)]),
        [projectId, threadId, title],
      )
      const artefact = await readStoredCanvasArtefact(id, thread, name)
      if (!artefact) return false
      // Delivered on the ordinary artefact channel so the Browser pane opens it
      // through exactly the path a fresh render takes — one behaviour, not two.
      event.sender.send(CANVAS_ARTEFACT_CHANNEL, artefact)
      return true
    },
  )
  ipcMain.handle('threads:create', (event, projectId: unknown, thread: unknown) => {
    assertMainFrameSender(event, win)
    const [id, payload] = parseIpcArgs(z.tuple([zProjectId, z.record(z.string(), z.unknown())]), [
      projectId,
      thread,
    ])
    const parsed = parseThreadValue(withoutMainOwnedThreadFields(payload))
    if (parsed === null) throw new IpcValidationError('Invalid thread payload')
    return createThread(id, parsed)
  })
  ipcMain.handle(
    'threads:append-message',
    (event, projectId: unknown, threadId: unknown, message: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, payload] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.record(z.string(), z.unknown())]),
        [projectId, threadId, message],
      )
      const parsed = parseMessageValue(payload)
      if (parsed === null) throw new IpcValidationError('Invalid message payload')
      return appendMessage(pid, tid, parsed)
    },
  )
  ipcMain.handle(
    'threads:update-meta',
    (event, projectId: unknown, threadId: unknown, patch: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, payload] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.record(z.string(), z.unknown())]),
        [projectId, threadId, patch],
      )
      return updateMeta(pid, tid, withoutMainOwnedThreadFields(payload))
    },
  )
  ipcMain.handle(
    'threads:record-model-selection',
    (event, projectId: unknown, threadId: unknown, by: unknown, from: unknown, to: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, actor, previous, selected] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.enum(['user', 'auto']), zModelId.optional(), zModelId]),
        [projectId, threadId, by, from, to],
      )
      const selection = {
        id: randomUUID(),
        recordedAt: Date.now(),
        by: actor,
        ...(previous !== undefined ? { from: previous } : {}),
        to: selected,
      }
      const line = {
        v: SPINE_SCHEMA_VERSION,
        type: 'model_selected' as const,
        ...selection,
      }
      return recordModelSelection(pid, tid, line).then(() => selection)
    },
  )
  ipcMain.handle(
    'threads:archive',
    (event, projectId: unknown, threadId: unknown, discard: unknown, stop: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, discardChanges, stopProcesses] = parseIpcArgs(
        z.tuple([
          zProjectId,
          zThreadId,
          z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
          z.boolean(),
        ]),
        [projectId, threadId, discard, stop],
      )
      return archiveStoredThread(pid, tid, discardChanges, stopProcesses, threadArchivingRuntime)
    },
  )
  ipcMain.handle('threads:delete', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, tid] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return deleteThreadResourcesAndStore(pid, tid, threadDeletionRuntime)
  })
  // Active threads that link to a URL or another thread: an indexed read of
  // recorded thread metadata that never touches a transcript.
  ipcMain.handle(
    'threads:backlinks',
    (event, projectId: unknown, kind: unknown, target: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, linkKind, linkTarget] = parseIpcArgs(
        z.tuple([zProjectId, z.enum(['url', 'thread']), z.string().min(1).max(2048)]),
        [projectId, kind, target],
      )
      return lookupThreadBacklinks(pid, linkKind, linkTarget)
    },
  )
  ipcMain.handle('threads:pending-approvals', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, tid] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return readPendingDeferrals({ projectId: pid, threadId: tid })
  })
  // Seed a freshly created fork's provider-format history from the thread it was
  // branched off. The renderer owns the visible transcript copy; this is the
  // half it cannot do, since `agent-history.json` never leaves the main process.
  ipcMain.handle(
    'threads:fork',
    (
      event,
      projectId: unknown,
      sourceThreadId: unknown,
      targetThreadId: unknown,
      throughMessageId: unknown,
    ) => {
      assertMainFrameSender(event, win)
      const [pid, sourceId, targetId, messageId] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, zThreadId, zNonEmptyString.max(256).optional()]),
        [projectId, sourceThreadId, targetThreadId, throughMessageId],
      )
      return forkThreadHistory(pid, sourceId, targetId, messageId)
    },
  )
  ipcMain.handle('threads:history-snapshot', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, tid] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return loadThreadHistorySnapshot(pid, tid)
  })
  ipcMain.handle(
    'threads:edit-history',
    (event, projectId: unknown, threadId: unknown, request: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, payload] = parseIpcArgs(
        z.tuple([
          zProjectId,
          zThreadId,
          z.object({
            expectedRevision: z.string().length(64),
            messages: z
              .array(
                z.object({
                  id: zNonEmptyString.max(256),
                  content: z.string().max(1_000_000),
                  included: z.boolean(),
                }),
              )
              .max(10_000),
          }),
        ]),
        [projectId, threadId, request],
      )
      return applyThreadHistoryEdit(pid, tid, payload, threadHistoryEditRuntime)
    },
  )
  ipcMain.handle(
    'threads:undo-history-edit',
    (event, projectId: unknown, threadId: unknown, expectedRevision: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, revision] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.string().length(64)]),
        [projectId, threadId, expectedRevision],
      )
      return undoThreadHistoryEdit(pid, tid, revision, threadHistoryEditRuntime)
    },
  )
  // The whole thread directory, zipped — the archive counterpart to the
  // renderer-side JSONL export. Bytes go back over IPC; the renderer names the
  // download and saves it, exactly as it does for the `.jsonl`.
  ipcMain.handle('threads:export-archive', async (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, tid] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return {
      bytes: await buildThreadArchive(pid, tid),
      build: {
        version: getElectronAppVersion(),
        buildCommit: getElectronBuildCommit(),
        buildDirty: getElectronBuildDirty(),
        packaged: isElectronAppPackaged(),
        platform: process.platform,
        capturedAt: new Date().toISOString(),
      },
    }
  })
  ipcMain.handle('threads:catalog', (event, projectId: unknown, query: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, q] = parseIpcArgs(z.tuple([zProjectId, z.string().max(512).optional()]), [
      projectId,
      query,
    ])
    return loadProjectCatalog(pid, q)
  })
  // A video attached in the composer. It is stored, never inlined — the
  // renderer gets back a path to hand the agent (see video-attachment-store).
  ipcMain.handle(
    'video:attach',
    async (event, projectId: unknown, threadId: unknown, video: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, payload] = parseIpcArgs(
        z.tuple([
          zProjectId,
          zThreadId,
          z.object({
            name: zNonEmptyString.max(255),
            mimeType: z.string().max(128),
            bytes: z.instanceof(Uint8Array).optional(),
            path: zPathString.optional(),
          }),
        ]),
        [projectId, threadId, video],
      )
      if (payload.path !== undefined) {
        // Already on disk in the workspace: reference it in place rather than
        // storing a second copy of a potentially very large file.
        return describeWorkspaceVideo(payload.path, payload.name, payload.mimeType)
      }
      if (!payload.bytes) throw new IpcValidationError('A video needs either bytes or a path')
      return storeVideoAttachment(pid, tid, {
        name: payload.name,
        mimeType: payload.mimeType,
        bytes: payload.bytes,
      })
    },
  )

  // An archive attached in the composer. Stored, never inlined — the renderer
  // gets back a path to hand the agent, which unpacks it with `read_archive`.
  ipcMain.handle(
    'archive:attach',
    async (event, projectId: unknown, threadId: unknown, archive: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, payload] = parseIpcArgs(
        z.tuple([
          zProjectId,
          zThreadId,
          z.object({
            name: zNonEmptyString.max(255),
            bytes: z.instanceof(Uint8Array).optional(),
            path: zPathString.optional(),
          }),
        ]),
        [projectId, threadId, archive],
      )
      if (payload.path !== undefined) {
        // Already on disk in the workspace: reference it in place rather than
        // storing a second copy.
        return describeWorkspaceArchive(payload.path, payload.name)
      }
      if (!payload.bytes) throw new IpcValidationError('An archive needs either bytes or a path')
      return storeArchiveAttachment(pid, tid, { name: payload.name, bytes: payload.bytes })
    },
  )

  // Read an attached video back so the preview modal can play it. Authorised to
  // the chat store and the workspace only — see readVideoForPlayback.
  ipcMain.handle('video:read', async (event, path: unknown) => {
    assertMainFrameSender(event, win)
    const videoPath = parseIpcArgs(zPathString, [path])
    return readVideoForPlayback(videoPath)
  })

  ipcMain.handle('threads:list-orphans', (event) => {
    assertMainFrameSender(event, win)
    const projectIds = recordArrayOrEmpty(storageGet('projects')).flatMap((project) => {
      const id = project['id']
      return typeof id === 'string' && id.length > 0 ? [id] : []
    })
    return listOrphanProjectStores(projectIds)
  })

  // Settings → Sources → Worktrees. Every call names the project by id and the
  // main process resolves its root itself, so the renderer never gets to say
  // which repository (or which directory) is operated on.
  const worktreeInput = (
    rawProjectId: unknown,
  ): { projectId: string; projectRoot: string } | null => {
    const projectId = parseIpcArgs(zProjectId, [rawProjectId])
    const projectRoot = getProjectRoot(projectId)
    return projectRoot === null ? null : { projectId, projectRoot }
  }

  ipcMain.handle('worktrees:list', async (event, rawProjectId: unknown) => {
    assertMainFrameSender(event, win)
    const target = worktreeInput(rawProjectId)
    if (!target) return []
    return listWorktreeInventory({
      ...target,
      runningThreadIds: new Set(listRunningThreadIds()),
    })
  })

  ipcMain.handle('worktrees:size', async (event, rawProjectId: unknown, rawPath: unknown) => {
    assertMainFrameSender(event, win)
    const [, path] = parseIpcArgs(z.tuple([zProjectId, zPathString]), [rawProjectId, rawPath])
    const target = worktreeInput(rawProjectId)
    if (!target) throw new IpcValidationError('That project is no longer available')
    return measureWorktreeSize({ ...target, path })
  })

  ipcMain.handle(
    'worktrees:cleanup-packages',
    async (event, rawProjectId: unknown, rawPath: unknown, rawRemove: unknown) => {
      assertMainFrameSender(event, win)
      const [, path, remove] = parseIpcArgs(z.tuple([zProjectId, zPathString, z.boolean()]), [
        rawProjectId,
        rawPath,
        rawRemove,
      ])
      const target = worktreeInput(rawProjectId)
      if (!target) throw new IpcValidationError('That project is no longer available')
      return cleanupWorktreePackages({
        ...target,
        path,
        remove,
        runningThreadIds: new Set(listRunningThreadIds()),
      })
    },
  )

  ipcMain.handle(
    'worktrees:open-terminal',
    async (event, rawProjectId: unknown, rawPath: unknown) => {
      assertMainFrameSender(event, win)
      const [, path] = parseIpcArgs(z.tuple([zProjectId, zPathString]), [rawProjectId, rawPath])
      const target = worktreeInput(rawProjectId)
      if (!target) throw new IpcValidationError('That project is no longer available')
      const root = await resolveRegisteredWorktreePath({ ...target, path })
      return openWorkspaceInExternalEditor('terminal', root)
    },
  )

  ipcMain.handle(
    'worktrees:remove',
    async (event, rawProjectId: unknown, rawPath: unknown, rawForce: unknown) => {
      assertMainFrameSender(event, win)
      const [, path, force] = parseIpcArgs(z.tuple([zProjectId, zPathString, z.boolean()]), [
        rawProjectId,
        rawPath,
        rawForce,
      ])
      const target = worktreeInput(rawProjectId)
      if (!target) throw new IpcValidationError('That project is no longer available')
      return removeWorktree({
        ...target,
        path,
        force,
        runningThreadIds: new Set(listRunningThreadIds()),
      })
    },
  )

  registerCustomizationHandlers(win)
  registerPluginHandlers(win, registry)
  registerSupervisorHandlers(win)

  registerAutomationHandlers(win)

  registerAppleDevelopmentHandlers(win, registry)

  registerInstructionHandlers(win)

  registerGitHandlers(win, isDispatcherThreadActive)
  registerGhHandlers(win)
  registerRemoteAgentHandlers(win, isDispatcherThreadActive)
  registerAcpHandlers(win)
  registerAboutHandlers(win)
  ipcMain.handle('shell:open-external', (event, url: unknown) => {
    assertMainFrameSender(event, win)
    const href = parseIpcArgs(z.url().max(2048), [url])
    if (!href.startsWith('http://') && !href.startsWith('https://')) {
      throw new IpcValidationError('URL must be http or https')
    }
    return shell.openExternal(href)
  })
  ipcMain.handle('shell:open-workspace-file-in-browser', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(threadPathArgs, rawArgs)
    const { root, projectRoot } = await resolveThreadExecutionContext(projectId, threadId)
    if (resolveSshHostForWorkspaceRoot(projectRoot)) {
      throw new IpcValidationError('Remote workspace files cannot be opened in a local browser')
    }
    const abs = await resolvePathWithinRoot(relPath, root)
    return shell.openExternal(await workspacePreviewFileUrl(root, abs))
  })
  ipcMain.handle('browser:workspace-file-url', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(threadPathArgs, rawArgs)
    const { root, projectRoot } = await resolveThreadExecutionContext(projectId, threadId)
    if (resolveSshHostForWorkspaceRoot(projectRoot)) {
      throw new IpcValidationError('Remote workspace files cannot be opened in a local browser')
    }
    const abs = await resolvePathWithinRoot(relPath, root)
    return workspacePreviewFileUrl(root, abs)
  })

  ipcMain.handle('editors:list', (event) => {
    assertMainFrameSender(event, win)
    return listExternalEditors()
  })
  ipcMain.handle('editors:open', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, parsedId] = parseIpcArgs(
      z.tuple([zProjectId, zThreadId, z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)]),
      rawArgs,
    )
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    return openWorkspaceInExternalEditor(parsedId, root)
  })

  ipcMain.handle('panes:popout', (event, mode: unknown, seed: unknown) => {
    assertMainFrameSender(event, win)
    const parsed = parseIpcArgs(
      z.enum([
        'explorer',
        'context',
        'side-chat',
        'terminal',
        'changes',
        'prs',
        'memories',
        'roadmap',
        'browser',
        'vnc',
      ]),
      [mode],
    )
    createPanePopoutWindow(parsed, seed)
  })

  ipcMain.handle('panes:take-popout-seed', (event, mode: unknown) => {
    assertMainFrameSender(event, win)
    const parsed = parseIpcArgs(
      z.enum([
        'explorer',
        'context',
        'side-chat',
        'terminal',
        'changes',
        'prs',
        'memories',
        'roadmap',
        'browser',
        'vnc',
      ]),
      [mode],
    )
    return takePopoutSeed(parsed)
  })

  registerToolPermissionHandlers(win, registry)

  registerMcpHandlers(win, registry)
  ipcMain.handle('workspace:is-trusted', () => isWorkspaceTrusted(getWorkspaceRoot()))
  ipcMain.handle('workspace:set-trusted', async (event, trusted: unknown) => {
    assertMainFrameSender(event, win)
    const root = getWorkspaceRoot()
    if (!root) throw new IpcValidationError('No workspace open')
    if (typeof trusted !== 'boolean') throw new IpcValidationError('trusted must be a boolean')
    // Spawning project MCP servers is the code-execution sink, so trusting a workspace
    // is a privileged action — only the main frame may request it (issue #100).
    const statuses = await setWorkspaceTrustAndReload(registry, root, trusted)
    broadcastToAppWindows('mcp:status-changed', statuses)
    return statuses
  })

  registerTestScenarioHandlers(win)
}
