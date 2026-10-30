import { ipcMain, shell, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zMcpServerName } from './ipc-guards.ts'
import { getCuratedServerStatuses, setCuratedServerEnabled } from '../services/mcp/mcp-curated.ts'
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
