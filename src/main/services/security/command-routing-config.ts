import { getSetting } from '../storage/settings.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import {
  COMMAND_ROUTES_SETTING,
  sanitizeCommandRoutes,
  type CommandRoute,
} from '@shared/command-routing.ts'
import { buildRoutingTable, resolveCommandRouting, type CommandRouting } from './command-routing.ts'

export { COMMAND_ROUTES_SETTING } from '@shared/command-routing.ts'

/** Read and validate the user's routing rules from settings. */
export function loadCommandRoutes(): CommandRoute[] {
  return sanitizeCommandRoutes(getSetting<unknown>(COMMAND_ROUTES_SETTING, []))
}

/**
 * Resolve a shell command against the merged routing table (built-in defaults +
 * user rules) and the current workspace root. Shared by the permission gate
 * (does it prompt?) and the shell tool (which sandbox overlay?) so the two never
 * drift on the same command.
 */
export function routeShellCommand(command: string): CommandRouting {
  return resolveCommandRouting(command, getWorkspaceRoot(), buildRoutingTable(loadCommandRoutes()))
}
