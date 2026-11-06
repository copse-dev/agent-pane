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
import { registerWorkspaceHandlers, storedWorkspaceProjects } from './workspace-handlers.ts'
import { registerMainWindowHandlers } from './main-window-handlers.ts'
import { registerProcessManagerHandlers } from './process-manager-handlers.ts'
import { app, BrowserWindow, webContents } from 'electron'
import { createProcessManagerSampler } from '../services/process-manager.ts'
import { readOwnedProcessRows } from '../services/process-manager-owned.ts'
import { recordArrayOrEmpty } from '@shared/unknown-value.ts'
import { broadcastToAppWindows } from '../windows/app-window-broadcast.ts'
import {
  getActiveProjectSshHost,
  getWorkspaceRoot,
  registerAllowedWorkspaceRoot,
  scheduleAllowedWorkspaceRootsBootstrap,
  seedAllowedWorkspaceRoots,
} from '../services/workspace.ts'
import { createElectronUserAlertSender } from '../services/user-alerts-electron.ts'
import { storageGet } from '../services/storage/storage.ts'
import {
  getMainWindowForWebContents,
  getMainWindowNavigation,
} from '../windows/create-main-window.ts'
import type { ThreadDeletionRuntime } from '../services/thread-deletion.ts'
import type { ThreadArchivingRuntime } from '../services/thread-archiving.ts'
import { ThreadAutoArchive } from '../services/thread-auto-archive.ts'
import type { ThreadHistoryEditRuntime } from '../services/thread-history-edit.ts'
import { listRunningThreadIds } from '../services/agent-service.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'
import { getPluginService } from '../services/plugins/plugin-service.ts'
import {
  setPluginToolRuntimeController,
  ToolingPluginToolRuntimeController,
} from '../services/plugins/plugin-tool-controller.ts'
import { createPluginBrowserPanelService } from '../services/plugins/plugin-browser-panel.ts'
import { setPluginBrowserService } from '../services/plugins/plugin-browser-service.ts'

import { setGitHubListWatchBroadcast } from '../services/github/backend/github-list-watch.ts'
import { reloadMcpServers } from '../services/mcp/mcp-registry.ts'
import { getFocusedMainWindow, syncDevtoolsShortcut } from '../windows/create-main-window.ts'

import { getGuardedYoloState, onGuardedYoloChanged } from '../services/security/guarded-yolo.ts'
import { getContainerRunService } from '../services/container-runtime/container-run-service.ts'

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

  registerProcessManagerHandlers(win, processManagerSnapshot)

  registerMainWindowHandlers(win)

  registerWorkspaceHandlers(win, registry, reloadMcpForWorkspace)

  registerBrowserShareHandlers(win)

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

  registerTestScenarioHandlers(win)
}
