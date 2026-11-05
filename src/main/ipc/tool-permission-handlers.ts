import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { defineHandler } from './define-handler.ts'
import { toolPermissionsResetArgs, toolPermissionsSetArgs } from './security-handler-args.ts'
import { getMcpServerStatuses } from '../services/mcp/mcp-registry.ts'
import {
  listToolPermissionCatalog,
  resetToolPermissions,
  updateToolPermissions,
  copseToolPermissionId,
} from '../services/security/tool-permissions.ts'
import { stopAllIsolatedDesktops } from '../services/isolated-desktop/desktop-service.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'

export function registerToolPermissionHandlers(win: BrowserWindow, registry: ToolRegistry): void {
  defineHandler(win, 'tool-permissions:list', z.tuple([]), () =>
    listToolPermissionCatalog(registry, getMcpServerStatuses()),
  )
  defineHandler(win, 'tool-permissions:set', toolPermissionsSetArgs, async (update) => {
    const result = await updateToolPermissions(registry, getMcpServerStatuses(), update)
    if (
      update.policy === 'block' &&
      update.toolIds.includes(copseToolPermissionId('isolated_copse'))
    ) {
      await stopAllIsolatedDesktops()
    }
    return result
  })
  defineHandler(win, 'tool-permissions:reset', toolPermissionsResetArgs, (reset) =>
    resetToolPermissions(registry, getMcpServerStatuses(), reset),
  )
}
