import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { defineHandler, defineSenderHandler } from './define-handler.ts'
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
import { confirmNativeAction } from '../services/native-human-confirmation.ts'

export function registerToolPermissionHandlers(win: BrowserWindow, registry: ToolRegistry): void {
  defineHandler(win, 'tool-permissions:list', z.tuple([]), () =>
    listToolPermissionCatalog(registry, getMcpServerStatuses()),
  )
  defineSenderHandler(
    win,
    'tool-permissions:set',
    toolPermissionsSetArgs,
    async (sender, update) => {
      if (update.policy === 'allow') {
        const detail = `Always allow these tools without their ordinary prompt?\n\n${update.toolIds.join('\n')}`
        if (
          !(await confirmNativeAction(sender, {
            title: 'Always allow tools?',
            detail,
            approveLabel: 'Always allow',
          }))
        ) {
          throw new Error('Tool permission change was not confirmed')
        }
      }
      const result = await updateToolPermissions(registry, getMcpServerStatuses(), update)
      if (
        update.policy === 'block' &&
        update.toolIds.includes(copseToolPermissionId('isolated_copse'))
      ) {
        await stopAllIsolatedDesktops()
      }
      return result
    },
  )
  defineSenderHandler(
    win,
    'tool-permissions:reset',
    toolPermissionsResetArgs,
    async (sender, reset) => {
      const detail = `Restore the default permissions for these tools? This may allow a tool that is currently blocked or set to Always ask.\n\n${reset.toolIds.join('\n')}`
      if (!(await confirmNativeAction(sender, { title: 'Reset tool permissions?', detail }))) {
        throw new Error('Tool permission reset was not confirmed')
      }
      return resetToolPermissions(registry, getMcpServerStatuses(), reset)
    },
  )
}
