import { BrowserWindow, dialog, ipcMain } from 'electron'
import { z } from 'zod'
import { syncPluginClientApi } from '../services/plugins/plugin-client-service.ts'
import { PLUGIN_CLIENT_API_ID } from '@copse/agent/plugins/plugin-client-api-plugin.ts'
import { broadcastToAppWindows } from '../windows/app-window-broadcast.ts'
import { assertMainFrameSender, parseIpcArgs, zNonEmptyString } from './ipc-guards.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'
import { initSkillsRegistry } from '../services/skills/skills-registry.ts'
import { getPluginService } from '../services/plugins/plugin-service.ts'
import { getPluginInstallService } from '../services/plugins/plugin-install-service.ts'
import {
  registerSkillTools,
  syncAppleDevelopmentTools,
  syncComputerUseTools,
  syncAdvisorStrategyTools,
  syncCiInvestigatorTools,
  syncLongHorizonTasksTools,
  syncReviewTools,
  syncBackgroundTasksTools,
  syncOkfMemoryTools,
  syncPiiTools,
  syncRoadmapPlanTools,
  syncReviewerInputTools,
} from '../services/registry-bootstrap.ts'
import { REVIEW_PLUGIN_ID } from '@copse/agent/plugins/review-plugin.ts'
import { LONG_HORIZON_TASKS_PLUGIN_ID } from '@copse/agent/plugins/long-horizon-tasks-plugin.ts'
import { ROADMAP_PLANS_PLUGIN_ID } from '@copse/agent/plugins/roadmap-plans-plugin.ts'
import { REVIEWER_INPUT_PLUGIN_ID } from '@copse/agent/plugins/reviewer-input-plugin.ts'
import { ADVISOR_STRATEGY_PLUGIN_ID } from '@copse/agent/plugins/advisor-strategy-plugin.ts'
import { OKF_MEMORIES_PLUGIN_ID } from '@copse/agent/plugins/okf-memories-plugin.ts'
import { CI_INVESTIGATOR_PLUGIN_ID } from '@copse/agent/plugins/ci-investigator-plugin.ts'
import { PII_REDACTION_PLUGIN_ID } from '@copse/agent/plugins/pii-redaction-plugin.ts'
import { DEVTOOLS_SHORTCUT_PLUGIN_ID } from '@copse/agent/plugins/devtools-shortcut-plugin.ts'
import { BACKGROUND_TASKS_PLUGIN_ID } from '@copse/agent/plugins/background-tasks-plugin.ts'
import {
  MCP_UI_CANVAS_PLUGIN_ID,
  ANIMATED_EXPLAINERS_SETTING_ID,
} from '@copse/agent/canvas-settings.ts'
import { DARK_FACTORY_PLUGIN_ID } from '@copse/agent/plugins/dark-factory-plugin.ts'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import { APPLE_DEVELOPMENT_PLUGIN_ID } from '@copse/agent/plugins/apple-development-plugin.ts'
import { COMPUTER_USE_PLUGIN_ID } from '@copse/agent/plugins/computer-use-plugin.ts'
import { disposeDesktopControlService } from '../services/desktop-control/desktop-control-service.ts'
import { getAutomationService } from '../services/automations/automation-service.ts'
import { getBranchCiAutomationService } from '../services/automations/branch-ci-automation-service.ts'
import { syncDarkFactorySensor } from '../services/supervisor/dark-factory-sensor.ts'
import { getTaskSupervisor } from '../services/supervisor/task-supervisor.ts'
import {
  getAppleDevelopmentService,
  type AppleDevelopmentService,
} from '../services/apple-development/apple-development-service.ts'
import { reloadMcpServers, reloadMcpServersForPluginToggle } from '../services/mcp/mcp-registry.ts'
import { syncDevtoolsShortcut } from '../windows/create-main-window.ts'

/**
 * Stop Apple work once the Apple Development plugin is turned off. The plugin
 * is app-wide, so that is every project's work, not only the one the primary
 * window shows (#3958).
 */
export async function stopAppleWorkWhenTurnedOff(
  enabled: boolean,
  service: Pick<AppleDevelopmentService, 'cancelAllProjects'>,
): Promise<void> {
  if (!enabled) await service.cancelAllProjects()
}

export function registerPluginHandlers(win: BrowserWindow, registry: ToolRegistry): void {
  // Plugin registry list (P3 of docs/plans/hooks-and-feature-packs.md). The
  // Settings plugin list ("about:addons") calls these to enumerate every
  // registered plugin, toggle enablement atomically (P1 contract), and read /
  // write plugin-scoped settings values under the manifest's declared schema.
  ipcMain.handle('plugins:list', async (event) => {
    assertMainFrameSender(event, win)
    await getPluginService().refreshInstalledPlugins()
    return { plugins: getPluginService().list() }
  })
  ipcMain.handle('plugins:list-installs', async (event) => {
    assertMainFrameSender(event, win)
    return getPluginInstallService().records()
  })
  ipcMain.handle('plugins:prepare-install', async (event, rawCatalogId: unknown) => {
    assertMainFrameSender(event, win)
    const catalogId = parseIpcArgs(zNonEmptyString.max(2048), [rawCatalogId])
    return getPluginInstallService().prepare(catalogId)
  })
  ipcMain.handle('plugins:cancel-install', async (event, rawToken: unknown) => {
    assertMainFrameSender(event, win)
    const token = parseIpcArgs(zNonEmptyString.max(128), [rawToken])
    await getPluginInstallService().cancel(token)
  })
  ipcMain.handle('plugins:commit-install', async (event, rawToken: unknown) => {
    assertMainFrameSender(event, win)
    const token = parseIpcArgs(zNonEmptyString.max(128), [rawToken])
    const result = await getPluginInstallService().commit(token)
    const service = getPluginService()
    const { pluginId } = result.record
    // The review the user just confirmed is the consent, so a first install
    // enables exactly what it showed. An update keeps the user's own toggle;
    // the registry still holds the previous revision until the refresh below.
    const enable =
      result.record.previousPin === undefined ||
      (service.registry.has(pluginId) && service.registry.isEnabled(pluginId))
    await service.refreshInstalledPlugins()
    if (service.hasUserPlugin(pluginId)) await service.setEnabled(pluginId, enable)
    await initSkillsRegistry()
    registerSkillTools(registry)
    const statuses = await reloadMcpServers(registry)
    broadcastToAppWindows('mcp:status-changed', statuses)
    return result
  })
  ipcMain.handle(
    'plugins:uninstall',
    async (event, rawPluginId: unknown, rawDeleteData: unknown) => {
      assertMainFrameSender(event, win)
      const pluginId = parseIpcArgs(zNonEmptyString.max(128), [rawPluginId])
      const deleteData = parseIpcArgs(z.boolean(), [rawDeleteData])
      const service = getPluginService()
      if (service.hasUserPlugin(pluginId)) await service.setEnabled(pluginId, false)
      const result = await getPluginInstallService().uninstall(pluginId, deleteData)
      await service.refreshInstalledPlugins()
      await initSkillsRegistry()
      registerSkillTools(registry)
      const statuses = await reloadMcpServers(registry)
      broadcastToAppWindows('mcp:status-changed', statuses)
      return result
    },
  )
  ipcMain.handle('plugins:rollback', async (event, rawPluginId: unknown) => {
    assertMainFrameSender(event, win)
    const pluginId = parseIpcArgs(zNonEmptyString.max(128), [rawPluginId])
    const service = getPluginService()
    // Rolling back returns to a revision the user already reviewed, so the
    // plugin is only paused for the switch and keeps the user's toggle after it.
    const wasEnabled = service.registry.has(pluginId) && service.registry.isEnabled(pluginId)
    if (service.hasUserPlugin(pluginId)) await service.setEnabled(pluginId, false)
    const result = await getPluginInstallService().rollback(pluginId)
    await service.refreshInstalledPlugins()
    if (wasEnabled && service.hasUserPlugin(pluginId)) await service.setEnabled(pluginId, true)
    await initSkillsRegistry()
    registerSkillTools(registry)
    const statuses = await reloadMcpServers(registry)
    broadcastToAppWindows('mcp:status-changed', statuses)
    return result
  })
  ipcMain.handle('plugins:add-source', async (event) => {
    assertMainFrameSender(event, win)
    const result = await dialog.showOpenDialog(win, {
      title: 'Add plugin',
      properties: ['openDirectory'],
    })
    const sourcePath = result.filePaths[0]
    if (!result.canceled && sourcePath) {
      await getPluginService().addPluginSource(sourcePath)
    }
    return { plugins: getPluginService().list() }
  })
  ipcMain.handle('plugins:set-enabled', async (event, rawId: unknown, rawEnabled: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zNonEmptyString.max(128), [rawId])
    const enabled = parseIpcArgs(z.boolean(), [rawEnabled])
    const pluginService = getPluginService()
    await pluginService.setEnabled(id, enabled)
    if (id === PLUGIN_CLIENT_API_ID) await syncPluginClientApi()
    if (pluginService.hasUserPlugin(id)) {
      // The plugin toggle is the portable component consent boundary. Refresh
      // both registries immediately so skills and MCP disappear atomically on
      // disable and become available without a restart on enable.
      await initSkillsRegistry()
      registerSkillTools(registry)
      const statuses = await reloadMcpServers(registry)
      broadcastToAppWindows('mcp:status-changed', statuses)
    }
    // Toggling the review plugin adds/removes its `review_changes` tool on the
    // live registry so the atomic plugin-disable also drops the tool from the
    // model tool list without an app restart (mirrors the setting toggles
    // above for the other syncable tools).
    if (id === REVIEW_PLUGIN_ID) {
      syncReviewTools(registry)
    }
    // Same for the `copse.long-horizon-tasks` plugin's `track_long_task` tool.
    if (id === LONG_HORIZON_TASKS_PLUGIN_ID) {
      syncLongHorizonTasksTools(registry)
    }
    // Same for the `copse.roadmap-plans` plugin's `roadmap_plan` tool.
    if (id === ROADMAP_PLANS_PLUGIN_ID) {
      syncRoadmapPlanTools(registry)
    }
    if (id === REVIEWER_INPUT_PLUGIN_ID) {
      syncReviewerInputTools(registry)
    }
    // Same for the `copse.advisor-strategy` plugin's `advisor` tool.
    if (id === ADVISOR_STRATEGY_PLUGIN_ID) {
      syncAdvisorStrategyTools(registry)
    }
    // Same for the `copse.okf-memories` plugin's `remember`/`recall` tools — the
    // atomic plugin-disable also drops the tools from the model tool list (and
    // stops the memory prompt block) without an app restart.
    if (id === OKF_MEMORIES_PLUGIN_ID) {
      syncOkfMemoryTools(registry)
    }
    // Same for the `copse.ci-investigator` plugin's entry and gh_run_* helper
    // tools; the register direction still requires `gh` availability.
    if (id === CI_INVESTIGATOR_PLUGIN_ID) {
      syncCiInvestigatorTools(registry)
    }
    // Same for the `copse.pii-redaction` plugin's `reveal_pii` tool — toggling the
    // plugin also arms/disarms the input rewrite and steering block, which read
    // the same plugin enablement (see `pii-redactor.ts`, `agent-system-prompt.ts`).
    if (id === PII_REDACTION_PLUGIN_ID) {
      syncPiiTools(registry)
    }
    // The `copse.devtools-shortcut` plugin contributes no tool — it owns the
    // `devtools-shortcut` capability. Toggling the plugin registers/unregisters the
    // global Ctrl+Shift+I shortcut so the atomic plugin-disable turns it off
    // without an app restart (mirrors the tool syncs above).
    if (id === DEVTOOLS_SHORTCUT_PLUGIN_ID) {
      syncDevtoolsShortcut()
    }
    // Same for the `copse.background-tasks` plugin's `run_background` tool — the
    // atomic plugin-disable also revokes the plugin's declared `loopback-bind`
    // sandbox relaxation (the permission-gate reads `isPermissionDeclared`).
    if (id === BACKGROUND_TASKS_PLUGIN_ID) {
      syncBackgroundTasksTools(registry)
    }
    if (id === DARK_FACTORY_PLUGIN_ID) {
      syncDarkFactorySensor()
    }
    // The `copse.mcp-ui-canvas` plugin gates the bundled canvas server, so its
    // `render_html_artefact` tool must connect or disconnect with the toggle —
    // the same live reload the Apple Development toggle does below.
    const bundledMcpStatuses = await reloadMcpServersForPluginToggle(registry, id)
    if (bundledMcpStatuses) broadcastToAppWindows('mcp:status-changed', bundledMcpStatuses)
    if (id === AUTOMATIONS_PLUGIN_ID) {
      getTaskSupervisor().syncCronTasks()
      await getAutomationService().sync()
      await getBranchCiAutomationService().sync()
    }
    if (id === COMPUTER_USE_PLUGIN_ID) {
      syncComputerUseTools(registry)
      if (!enabled) disposeDesktopControlService()
    }
    if (id === APPLE_DEVELOPMENT_PLUGIN_ID) {
      syncAppleDevelopmentTools(registry)
      const statuses = await reloadMcpServers(registry)
      broadcastToAppWindows('mcp:status-changed', statuses)
      await stopAppleWorkWhenTurnedOff(enabled, getAppleDevelopmentService())
    }
    return { plugins: getPluginService().list() }
  })
  ipcMain.handle(
    'plugins:set-setting',
    async (event, rawId: unknown, rawKey: unknown, rawValue: unknown) => {
      assertMainFrameSender(event, win)
      const id = parseIpcArgs(zNonEmptyString.max(128), [rawId])
      const key = parseIpcArgs(zNonEmptyString.max(128), [rawKey])
      // Plugin-scoped setting values are declaratively-shaped by the manifest;
      // the renderer sends the primitive it read from the form. Cap to a sane
      // upper bound so a compromised renderer can't stuff arbitrary payloads.
      const value = parseIpcArgs(
        z.union([z.boolean(), z.number(), z.string().max(8192), z.null()]),
        [rawValue],
      )
      await getPluginService().setSetting(id, key, value)
      if (id === MCP_UI_CANVAS_PLUGIN_ID && key === ANIMATED_EXPLAINERS_SETTING_ID) {
        const statuses = await reloadMcpServersForPluginToggle(registry, id)
        if (statuses) broadcastToAppWindows('mcp:status-changed', statuses)
      }
      return { plugins: getPluginService().list() }
    },
  )
}
