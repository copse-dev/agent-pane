import { getSetting } from '../storage/settings.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/index.ts'
import { isWorkspaceTrusted } from './workspace-trust.ts'
import { TRUSTED_COMMANDS_SETTING, sanitizeTrustedCommands } from '@shared/command-routing.ts'
import { resolveCommandRouting, type CommandRouting } from './command-routing.ts'
import { shellRequiresOutsideSandbox } from './permission-policy.ts'

export { TRUSTED_COMMANDS_SETTING } from '@shared/command-routing.ts'

// Cache the parsed allow-list Set, rebuilt only when the persisted value changes.
// getSetting validates+returns a fresh array each call, so key the cache on the
// serialized value rather than reference identity.
let cache: { key: string; set: Set<string> } | null = null

function trustedCommandSet(): Set<string> {
  const list = sanitizeTrustedCommands(getSetting<unknown>(TRUSTED_COMMANDS_SETTING, []))
  const key = list.join('\n')
  if (!cache || cache.key !== key) cache = { key, set: new Set(list) }
  return cache.set
}

/**
 * Resolve a shell command's trusted-command routing, applying the two gates that
 * make the allow-list safe to honour: it is ignored unless auto-run is enabled
 * AND the workspace is explicitly trusted (a cloned, untrusted repo can ship a
 * routing table but never gets its commands auto-run — the same trust model that
 * keeps project MCP servers inert). Returns `defer` when either gate is closed.
 *
 * Both the permission gate (does it prompt?) and the shell tool / todo checks
 * (does it run unsandboxed?) call this on the SAME raw command, so the prompt
 * decision and the execution context can never disagree.
 */
export function routeShellCommand(command: string): CommandRouting {
  if (!getSetting<boolean>('autoRunSandboxCommands', true)) {
    return { outcome: 'defer', reasons: ['auto-run disabled'] }
  }
  const root = getWorkspaceRoot()
  if (!isWorkspaceTrusted(root)) {
    return { outcome: 'defer', reasons: ['workspace not trusted'] }
  }
  return resolveCommandRouting(command, root, trustedCommandSet())
}

/**
 * Whether a shell command should run outside the project sandbox: true for a
 * trusted allow-listed command (runs unsandboxed with no prompt) or, failing
 * that, for a command the static heuristic flags as needing network / outside
 * access. Single source of truth for run_shell and todo verification.
 */
export function shellRunsOutsideSandbox(command: string): boolean {
  if (routeShellCommand(command).outcome === 'allow') return true
  return shellRequiresOutsideSandbox(command, getWorkspaceRoot(), isProjectSandboxEnabled())
}
