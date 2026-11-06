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
import { registerWorktreeHandlers } from './worktree-handlers.ts'
import { registerContainerHandlers } from './container-handlers.ts'
import { registerGuardedYoloHandlers } from './guarded-yolo-handlers.ts'
import { registerThreadHandlers } from './thread-handlers.ts'
import { registerPaneHandlers } from './pane-handlers.ts'
import { registerEditorHandlers } from './editor-handlers.ts'
import { registerShellHandlers } from './shell-handlers.ts'
import { registerIndexHandlers } from './index-handlers.ts'
import { registerFsHandlers } from './fs-handlers.ts'
import { registerBrowserShareHandlers } from './browser-share-handlers.ts'
import { app, BrowserWindow, dialog, ipcMain, webContents, type WebContents } from 'electron'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { scaffoldProject } from '../services/project-scaffold.ts'
import { createProcessManagerSampler } from '../services/process-manager.ts'
import { readOwnedProcessRows } from '../services/process-manager-owned.ts'
import { stopSupervisedBackgroundProcess } from '../services/exec/supervised-background-process.ts'
import { recordArrayOrEmpty } from '@shared/unknown-value.ts'
import { broadcastToAppWindows } from '../windows/app-window-broadcast.ts'
import {
  assertAllowedWorkspaceRoot,
  getActiveProjectSshHost,
  getWorkspaceRoot,
  registerAllowedWorkspaceRoot,
  resolveSshHostForWorkspaceRoot,
  scheduleAllowedWorkspaceRootsBootstrap,
  seedAllowedWorkspaceRoots,
  workspaceProjectsToSeed,
  setWorkspaceRoot,
  type WorkspaceProjectRef,
} from '../services/workspace.ts'
import {
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  zPathString,
  zProjectId,
  zThreadId,
  mainWindowNavigationSchema,
} from './ipc-guards.ts'
import { startWorkspaceIndexing } from '../services/search/workspace-indexing.ts'
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
import type { ThreadDeletionRuntime } from '../services/thread-deletion.ts'
import type { ThreadArchivingRuntime } from '../services/thread-archiving.ts'
import { ThreadAutoArchive } from '../services/thread-auto-archive.ts'
import type { ThreadHistoryEditRuntime } from '../services/thread-history-edit.ts'
import { listRunningThreadIds } from '../services/agent-service.ts'
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

import { getGuardedYoloState, onGuardedYoloChanged } from '../services/security/guarded-yolo.ts'
import { getContainerRunService } from '../services/container-runtime/container-run-service.ts'

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

  registerBrowserShareHandlers(win)

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

  registerFsHandlers(win)

  registerIndexHandlers(win)

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

  registerGuardedYoloHandlers(win)

  registerContainerHandlers(win, startingContainerThreads)
  registerThreadHandlers(win, {
    autoArchive,
    notifyAutoArchive,
    threadArchivingRuntime,
    threadDeletionRuntime,
    threadHistoryEditRuntime,
  })

  registerWorktreeHandlers(win)

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
  registerShellHandlers(win)

  registerEditorHandlers(win)

  registerPaneHandlers(win)

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
