import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { defineHandler } from './define-handler.ts'
import { toolPermissionsResetArgs, toolPermissionsSetArgs } from './security-handler-args.ts'
import { getMcpServerStatuses } from '../services/mcp/mcp-registry.ts'
import {
  listToolPermissionCatalog,
  resetToolPermissions,
  updateToolPermissions,
} from '../services/security/tool-permissions.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'

export function registerToolPermissionHandlers(win: BrowserWindow, registry: ToolRegistry): void {
  defineHandler(win, 'tool-permissions:list', z.tuple([]), () =>
    listToolPermissionCatalog(registry, getMcpServerStatuses()),
  )
  defineHandler(win, 'tool-permissions:set', toolPermissionsSetArgs, (update) =>
    updateToolPermissions(registry, getMcpServerStatuses(), update),
  )
  defineHandler(win, 'tool-permissions:reset', toolPermissionsResetArgs, (reset) =>
    resetToolPermissions(registry, getMcpServerStatuses(), reset),
  )
}
