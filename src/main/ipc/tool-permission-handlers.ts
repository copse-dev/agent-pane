import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { TOOL_PERMISSION_POLICIES } from '@shared/types/tool-permissions.ts'
import { assertMainFrameSender, parseIpcArgs } from './ipc-guards.ts'
import { getMcpServerStatuses } from '../services/mcp/mcp-registry.ts'
import {
  listToolPermissionCatalog,
  resetToolPermissions,
  updateToolPermissions,
} from '../services/security/tool-permissions.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'

export function registerToolPermissionHandlers(win: BrowserWindow, registry: ToolRegistry): void {
  ipcMain.handle('tool-permissions:list', (event) => {
    assertMainFrameSender(event, win)
    return listToolPermissionCatalog(registry, getMcpServerStatuses())
  })
  ipcMain.handle('tool-permissions:set', async (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    const update = parseIpcArgs(
      z.object({
        toolIds: z.array(z.string().min(1).max(8192)).max(2_000),
        policy: z.enum(TOOL_PERMISSION_POLICIES),
      }),
      [raw],
    )
    return updateToolPermissions(registry, getMcpServerStatuses(), update)
  })
  ipcMain.handle('tool-permissions:reset', async (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    const reset = parseIpcArgs(
      z.object({ toolIds: z.array(z.string().min(1).max(8192)).max(2_000) }),
      [raw],
    )
    return resetToolPermissions(registry, getMcpServerStatuses(), reset)
  })
}
