import { ipcMain, shell, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zMcpServerName } from './ipc-guards.ts'
import {
  CURATED_MCP_SERVERS,
  getCuratedServerStatuses,
  setCuratedServerEnabled,
} from '../services/mcp/mcp-curated.ts'
import {
  copseUserMcpConfigPath,
  listUserMcpServers,
  mcpUserServerInputSchema,
  removeUserMcpServer,
  saveUserMcpServer,
} from '../services/mcp/mcp-user-config.ts'
import { CANVAS_SERVER_NAME } from '../services/mcp/bundled-mcp-server.ts'
import type { McpUserServerSaveResult } from '@shared/types/mcp-user-servers.ts'
import { XCODEBUILD_MCP_SERVER_NAME } from '../services/apple-development/xcodebuildmcp.ts'
import { signInMcpServer, signOutMcpServer } from '../services/mcp/mcp-oauth.ts'
import {
  getMcpServerStatuses,
  getMcpSignInTarget,
  onMcpStatusesChanged,
  reloadMcpServers,
  setMcpServerUserEnabled,
} from '../services/mcp/mcp-registry.ts'
import { getPluginService } from '../services/plugins/plugin-service.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'
import { broadcastToAppWindows } from '../windows/app-window-broadcast.ts'

export function registerMcpHandlers(win: BrowserWindow, registry: ToolRegistry): void {
  ipcMain.handle('mcp:list', (event) => {
    assertMainFrameSender(event, win)
    return getMcpServerStatuses()
  })
  ipcMain.handle('mcp:reload', async (event) => {
    assertMainFrameSender(event, win)
    const statuses = await reloadMcpServers(registry)
    broadcastToAppWindows('mcp:status-changed', statuses)
    return statuses
  })
  ipcMain.handle('mcp:set-enabled', async (event, name: unknown, enabled: unknown) => {
    assertMainFrameSender(event, win)
    const [parsedName, parsedEnabled] = parseIpcArgs(z.tuple([zMcpServerName, z.boolean()]), [
      name,
      enabled,
    ])
    await setMcpServerUserEnabled(parsedName, parsedEnabled)
    const statuses = await reloadMcpServers(registry)
    broadcastToAppWindows('mcp:status-changed', statuses)
    return statuses
  })
  // Status changes the registry makes on its own (a sign-in refused while a
  // server was connected) reach Settings the same way a reload's do.
  onMcpStatusesChanged((statuses) => {
    broadcastToAppWindows('mcp:status-changed', statuses)
  })
  // One browser sign-in per server at a time; starting another cancels the first.
  const mcpSignIns = new Map<string, AbortController>()
  const mcpSignInTargetUrl = (name: string): string => {
    const target = getMcpSignInTarget(name)
    if (target?.url === undefined) {
      throw new Error(`"${name}" is not a connected remote MCP server.`)
    }
    return target.url
  }
  ipcMain.handle('mcp:sign-in', async (event, name: unknown) => {
    assertMainFrameSender(event, win)
    const parsedName = parseIpcArgs(zMcpServerName, [name])
    const serverUrl = mcpSignInTargetUrl(parsedName)
    mcpSignIns.get(parsedName)?.abort()
    const controller = new AbortController()
    mcpSignIns.set(parsedName, controller)
    try {
      await signInMcpServer(serverUrl, {
        signal: controller.signal,
        openExternal: (url) => shell.openExternal(url),
      })
    } finally {
      if (mcpSignIns.get(parsedName) === controller) mcpSignIns.delete(parsedName)
    }
    const statuses = await reloadMcpServers(registry)
    broadcastToAppWindows('mcp:status-changed', statuses)
    return statuses
  })
  ipcMain.handle('mcp:cancel-sign-in', (event, name: unknown) => {
    assertMainFrameSender(event, win)
    const parsedName = parseIpcArgs(zMcpServerName, [name])
    mcpSignIns.get(parsedName)?.abort()
  })
  ipcMain.handle('mcp:sign-out', async (event, name: unknown) => {
    assertMainFrameSender(event, win)
    const parsedName = parseIpcArgs(zMcpServerName, [name])
    await signOutMcpServer(mcpSignInTargetUrl(parsedName))
    const statuses = await reloadMcpServers(registry)
    broadcastToAppWindows('mcp:status-changed', statuses)
    return statuses
  })
  // Names a server added in Settings may not take: every server another source
  // defines (the user's file would be shadowed or would shadow it), the
  // reviewed catalog, and the names Copse reserves for its own servers.
  const mcpNamesTakenOutsideUserConfig = (): Map<string, string> => {
    const userPath = copseUserMcpConfigPath()
    const taken = new Map<string, string>([
      [CANVAS_SERVER_NAME, 'a server built into Copse'],
      [XCODEBUILD_MCP_SERVER_NAME, 'a server built into Copse'],
    ])
    for (const entry of CURATED_MCP_SERVERS) taken.set(entry.name, 'a Copse reviewed server')
    for (const status of getMcpServerStatuses()) {
      if (status.source === userPath || taken.has(status.name)) continue
      taken.set(status.name, status.source ? `a server in ${status.source}` : 'another server')
    }
    return taken
  }
  const reloadAfterUserConfigChange = async (
    result: McpUserServerSaveResult,
  ): Promise<McpUserServerSaveResult> => {
    if (!result.ok) return result
    const statuses = await reloadMcpServers(registry)
    broadcastToAppWindows('mcp:status-changed', statuses)
    return result
  }
  ipcMain.handle('mcp:list-user-servers', (event) => {
    assertMainFrameSender(event, win)
    return listUserMcpServers()
  })
  ipcMain.handle('mcp:save-user-server', async (event, input: unknown, previousName: unknown) => {
    assertMainFrameSender(event, win)
    const [parsedInput, parsedPrevious] = parseIpcArgs(
      z.tuple([mcpUserServerInputSchema, zMcpServerName.optional()]),
      [input, previousName],
    )
    const result = await saveUserMcpServer(parsedInput, {
      takenNames: mcpNamesTakenOutsideUserConfig(),
      ...(parsedPrevious === undefined ? {} : { previousName: parsedPrevious }),
    })
    return reloadAfterUserConfigChange(result)
  })
  ipcMain.handle('mcp:remove-user-server', async (event, name: unknown) => {
    assertMainFrameSender(event, win)
    const parsedName = parseIpcArgs(zMcpServerName, [name])
    return reloadAfterUserConfigChange(await removeUserMcpServer(parsedName))
  })
  ipcMain.handle('mcp:list-curated', (event) => {
    assertMainFrameSender(event, win)
    return getCuratedServerStatuses(getMcpServerStatuses())
  })
  ipcMain.handle('mcp:list-declared', (event) => {
    assertMainFrameSender(event, win)
    return getPluginService().declaredMcpServers()
  })
  ipcMain.handle('mcp:set-curated-enabled', async (event, name: unknown, enabled: unknown) => {
    assertMainFrameSender(event, win)
    const [parsedName, parsedEnabled] = parseIpcArgs(z.tuple([zMcpServerName, z.boolean()]), [
      name,
      enabled,
    ])
    await setCuratedServerEnabled(parsedName, parsedEnabled)
    const statuses = await reloadMcpServers(registry)
    broadcastToAppWindows('mcp:status-changed', statuses)
    return getCuratedServerStatuses(statuses)
  })
}
