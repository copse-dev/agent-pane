import { getWorkspaceRoot } from '../workspace.ts'
import { isWorkspaceTrusted } from './workspace-trust.ts'
import { runPermissionHooks } from '../skills/cursor-hooks.ts'
import type { CursorPermissionHookEvent } from '@shared/types/cursor-hooks.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/index.ts'
import { classifyShellScope } from './safety-classifier.ts'
import { requestApproval } from '../approval.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import {
  SANDBOX_TOOLS,
  decideShellPermission,
  decideMcpPermission,
  decideWebFetchPermission,
  decideWebSearchPermission,
  describeMcpAnnotations,
  fetchUrlFromArgs,
  formatWebPromptBody,
  shellCommandFromArgs,
  formatShellPromptBody,
  formatPortBindingPromptBody,
  backgroundAllowsPortBinding,
  backgroundCommandFromArgs,
  formatExternalSandboxPromptBody,
  formatInstallPromptBody,
  formatEphemeralRunnerPromptBody,
  shellRequiresOutsideSandbox,
  mcpToolLabel,
  GITHUB_READONLY_CI_TOOLS,
} from './permission-policy.ts'
import { detectPackageInstall } from './safe-install.ts'
import {
  BROWSER_TOOLS,
  READ_ONLY_BROWSER_TOOLS,
  BROWSER_ALLOW_USER_APPROVAL_SETTING,
  decideBrowserNavigation,
  formatBrowserPromptBody,
} from '../browser/browser-origin-policy.ts'
import {
  DEFAULT_WEB_ALLOWED_ORIGINS,
  WEB_ALLOWED_ORIGINS_SETTING,
  WEB_ALLOW_USER_APPROVAL_SETTING,
  grantWebOriginForNextFetch,
  normalizeWebAllowedOrigins,
  webAllowedOriginsWithDefaults,
} from './web-origin-policy.ts'
import { formatUnsandboxedPromptBody } from './sandbox-failure.ts'
import { getMcpToolMeta, isMcpToolRemembered, rememberMcpTool } from '../mcp/mcp-registry.ts'
import { CUSTOM_TOOL_PREFIX, customToolLabel } from '../mcp/custom-tools-config.ts'
import {
  customToolRequiresApproval,
  isCustomToolRemembered,
  rememberCustomTool,
} from '../mcp/custom-tools-registry.ts'
import { isAgentRunReadonly } from '../agent-run-readonly.ts'
import { getReadonlyToolBlockReason } from '@shared/tools/readonly-tools.ts'

export type { ShellPermissionDecision, PermissionCheck } from './permission-policy.ts'
export { decideShellPermission } from './permission-policy.ts'

import type { PermissionCheck } from './permission-policy.ts'

async function promptShell(
  command: string,
  reasons: string[],
  outsideSandbox: boolean,
): Promise<boolean> {
  const { approved } = await requestApproval({
    title: outsideSandbox ? 'Run outside sandbox?' : 'Run shell command?',
    body: outsideSandbox
      ? formatExternalSandboxPromptBody(command, reasons)
      : formatShellPromptBody(command, reasons),
    type: 'shell',
  })
  return approved
}

/** Prompt when a sandboxed command failed and may succeed unsandboxed. */
export async function promptUnsandboxedShell(command: string, reasons: string[]): Promise<boolean> {
  const { approved } = await requestApproval({
    title: 'Run outside sandbox?',
    body: formatUnsandboxedPromptBody(command, reasons),
    type: 'shell',
  })
  return approved
}

/**
 * Prompt to install Socket Firewall before running a package install. Declining
 * cancels the install rather than running it unscanned.
 */
export async function promptInstallSocketFirewall(command: string): Promise<boolean> {
  const { approved } = await requestApproval({
    title: 'Install Socket Firewall?',
    body: [
      'This command installs packages and will be scanned by Socket Firewall (sfw)',
      'to block known-malicious packages — but sfw is not installed yet.',
      '',
      'Install it now (npm install -g sfw) and continue? Declining cancels the install.',
      '',
      command,
    ].join('\n'),
    type: 'shell',
  })
  return approved
}

async function checkMcpPermission(toolName: string, args: unknown): Promise<boolean> {
  const meta = getMcpToolMeta(toolName)
  const decision = decideMcpPermission({
    toolName,
    annotations: meta?.annotations,
    remembered: isMcpToolRemembered(toolName),
    autoAllowReadOnly: getSetting<boolean>('mcpAutoAllowReadOnly', false),
    bundled: meta?.bundled ?? false,
  })
  if (decision.action === 'allow') return true

  const hints = describeMcpAnnotations(meta?.annotations)
  const bodyLines = [JSON.stringify(args, null, 2)]
  if (hints.length) bodyLines.push('', `Hints: ${hints.join(', ')}`)

  const { approved, remember } = await requestApproval({
    title: `MCP tool: ${mcpToolLabel(toolName)}`,
    body: bodyLines.join('\n'),
    type: 'mcp',
    allowRemember: true,
  })
  if (approved && remember) await rememberMcpTool(toolName)
  return approved
}

async function rememberWebOrigin(origin: string): Promise<void> {
  const saved = getSetting<string[] | null>(WEB_ALLOWED_ORIGINS_SETTING, null)
  const allowed = webAllowedOriginsWithDefaults(saved)
  if (!allowed.includes(origin)) {
    await setSetting(WEB_ALLOWED_ORIGINS_SETTING, normalizeWebAllowedOrigins([...allowed, origin]))
  }
}

async function promptWebOrigin(origin: string, detail: string): Promise<boolean> {
  const { approved, remember } = await requestApproval({
    title: 'Allow web origin?',
    body: formatWebPromptBody(origin, detail),
    type: 'web',
    allowRemember: true,
    rememberLabel: 'Always allow this web origin',
  })
  if (!approved) return false
  if (remember) await rememberWebOrigin(origin)
  else grantWebOriginForNextFetch(origin)
  return true
}

async function checkFetchUrlPermission(args: unknown): Promise<boolean> {
  const url = fetchUrlFromArgs(args)
  if (!url) throw new Error('fetch_url requires a URL argument')

  const saved = getSetting<string[] | null>(WEB_ALLOWED_ORIGINS_SETTING, null)
  const decision = decideWebFetchPermission({
    url,
    allowedOrigins: webAllowedOriginsWithDefaults(saved),
    allowUserApproval: getSetting<boolean>(WEB_ALLOW_USER_APPROVAL_SETTING, true),
  })
  if (decision.action === 'allow') return true
  if (decision.action === 'deny') {
    throw new Error(`Web access denied: ${decision.reasons.join('; ')}`)
  }
  return promptWebOrigin(decision.origin, url)
}

async function checkWebSearchPermission(): Promise<boolean> {
  const saved = getSetting<string[] | null>(WEB_ALLOWED_ORIGINS_SETTING, null)
  const decision = decideWebSearchPermission({
    allowedOrigins: webAllowedOriginsWithDefaults(saved),
    allowUserApproval: getSetting<boolean>(WEB_ALLOW_USER_APPROVAL_SETTING, true),
  })
  if (decision.action === 'allow') return true
  if (decision.action === 'deny') {
    throw new Error(`Web search denied: ${decision.reasons.join('; ')}`)
  }
  return promptWebOrigin(
    decision.origin,
    `DuckDuckGo search is allowed by default through: ${DEFAULT_WEB_ALLOWED_ORIGINS.join(', ')}`,
  )
}

/**
 * Custom tools run user-authored code in-process with full privilege, so a call
 * always prompts unless the user remembered this exact tool — the same opt-in
 * model as MCP tools (custom tools have no server-reported read-only hints).
 *
 * A tool that declared `requiresApproval: true` opts out of remembering: it
 * always prompts, so a remembered grant is ignored for those tools.
 */
async function checkCustomToolPermission(toolName: string, args: unknown): Promise<boolean> {
  const alwaysPrompt = customToolRequiresApproval(toolName)
  if (!alwaysPrompt && isCustomToolRemembered(toolName)) return true
  const { approved, remember } = await requestApproval({
    title: `Custom tool: ${customToolLabel(toolName)}`,
    body: JSON.stringify(args, null, 2),
    type: 'mcp',
    // No "remember" for always-prompt tools: a saved grant would never be honored.
    allowRemember: !alwaysPrompt,
  })
  if (approved && remember && !alwaysPrompt) await rememberCustomTool(toolName)
  return approved
}

async function checkShellPermission(args: unknown): Promise<boolean> {
  const command = shellCommandFromArgs(args)
  if (!command) return promptShell('(invalid command)', ['missing command argument'], false)

  const workspaceRoot = getWorkspaceRoot()
  const sandboxEnabled = isProjectSandboxEnabled()
  const decision = decideShellPermission(command, {
    workspaceRoot,
    sandboxEnabled,
    autoRun: getSetting<boolean>('autoRunSandboxCommands', true),
    classification: sandboxEnabled ? null : await classifyShellScope(command),
    confidenceThreshold: getSetting<number>('safetyConfidenceThreshold', 0.85),
  })

  if (decision.action === 'allow') return true

  const outsideSandbox = shellRequiresOutsideSandbox(command, workspaceRoot, sandboxEnabled)

  // A plain package install gets a dedicated, readable approval rather than the
  // generic external-command reason list. Only when the install is the *sole*
  // flagged signal (one reason) — compound or registry-redirected commands keep
  // the full reason list so extra risks (curl, custom registry, …) stay visible.
  const install = detectPackageInstall(command)
  if (install.isInstall && decision.reasons.length === 1) {
    const safeInstall = getSetting<boolean>('safeInstallEnabled', true)
    const { approved } = await requestApproval(
      install.isEphemeralRunner
        ? {
            title: 'Run package command?',
            body: formatEphemeralRunnerPromptBody(command, { outsideSandbox, safeInstall }),
            type: 'shell',
          }
        : {
            title: 'Run package install?',
            body: formatInstallPromptBody(command, {
              outsideSandbox,
              safeInstall,
              jsManager: install.jsManager,
            }),
            type: 'shell',
          },
    )
    return approved
  }

  return promptShell(command, decision.reasons, outsideSandbox)
}

function browserUrlFromArgs(args: unknown): string | null {
  if (typeof args !== 'object' || args === null || !('url' in args)) return null
  const url = (args as { url?: unknown }).url
  return typeof url === 'string' ? url : null
}

async function rememberBrowserOrigin(origin: string): Promise<void> {
  const saved = getSetting<string[]>('browserAllowedOrigins', [])
  if (!saved.includes(origin)) {
    await setSetting('browserAllowedOrigins', [...saved, origin])
  }
}

async function checkBrowserNavigatePermission(args: unknown): Promise<boolean> {
  const url = browserUrlFromArgs(args)
  if (!url) throw new Error('browser_navigate requires a url argument')

  const decision = decideBrowserNavigation({
    url,
    allowedOrigins: getSetting<string[]>('browserAllowedOrigins', []),
    allowUserApproval: getSetting<boolean>(BROWSER_ALLOW_USER_APPROVAL_SETTING, true),
  })
  if (decision.action === 'allow') return true
  if (decision.action === 'deny') {
    throw new Error(`Browser navigation denied: ${decision.reasons.join('; ')}`)
  }

  const { approved, remember } = await requestApproval({
    title: 'Allow browser navigation?',
    body: formatBrowserPromptBody(decision.origin, url),
    type: 'mcp',
    allowRemember: true,
  })
  if (approved && remember) await rememberBrowserOrigin(decision.origin)
  return approved
}

const PORT_BINDING_ALLOWED_ROOTS_SETTING = 'portBindingAllowedRoots'

/**
 * Gate the `run_background` tool. Only starting a task that binds a loopback
 * port is an escalation worth prompting for; a plain contained task (and the
 * list/logs/stop management actions) auto-runs like an in-sandbox run_shell.
 * A port-binding start prompts the first time per workspace, then remembers the
 * grant — the same prompt-once model as browser origins and MCP servers.
 */
async function checkBackgroundProcessPermission(args: unknown): Promise<boolean> {
  if (!backgroundAllowsPortBinding(args)) return true

  const root = getWorkspaceRoot()
  if (!root) throw new Error('No workspace open.')

  const allowed = getSetting<string[]>(PORT_BINDING_ALLOWED_ROOTS_SETTING, [])
  if (allowed.includes(root)) return true

  const { approved, remember } = await requestApproval({
    title: 'Allow this project to bind a local port?',
    body: formatPortBindingPromptBody(root, backgroundCommandFromArgs(args)),
    type: 'shell',
    allowRemember: true,
    rememberLabel: 'Always allow local port binding in this project',
  })
  if (approved && remember && !allowed.includes(root)) {
    await setSetting(PORT_BINDING_ALLOWED_ROOTS_SETTING, [...allowed, root])
  }
  return approved
}

/** Gate a raw shell command string (todo verification, etc.) through the same policy as run_shell. */
export async function ensureShellCommandPermitted(command: string): Promise<boolean> {
  return checkShellPermission({ command })
}

/** Integrated terminal is a direct user UI action; PTY always runs outside seatbelt (#180). */
// eslint-disable-next-line @typescript-eslint/require-await -- part of the uniformly-async permission-gate API (awaited by the terminal IPC handler)
export async function ensureTerminalPermitted(): Promise<boolean> {
  if (!getWorkspaceRoot()) throw new Error('No workspace open.')
  return true
}

/** Map a tool call to the Cursor permission-hook event + payload it should fire. */
function cursorHookForTool(
  toolName: string,
  args: unknown,
): { event: CursorPermissionHookEvent; payload: Record<string, unknown> } | null {
  if (toolName === 'run_shell') {
    const command = shellCommandFromArgs(args) ?? ''
    return { event: 'beforeShellExecution', payload: { command, cwd: getWorkspaceRoot() ?? '' } }
  }
  if (toolName.startsWith('mcp__')) {
    return { event: 'beforeMCPExecution', payload: { tool_name: toolName, tool_input: args } }
  }
  if (toolName === 'read_file') {
    const rawPath =
      typeof args === 'object' && args !== null ? (args as { path?: unknown }).path : undefined
    const path = typeof rawPath === 'string' ? rawPath : ''
    return { event: 'beforeReadFile', payload: { file_path: path, content: '' } }
  }
  return null
}

/**
 * Run any matching Cursor hooks (https://cursor.com/docs/hooks) for this tool call.
 * Hooks can only *block* — an allow/ask still falls through to Copse's own gate — so
 * a deny here is the one short-circuit. Gated behind `cursorHooksEnabled` (default off)
 * because honouring hooks spawns user/project scripts on the agent's hot path.
 */
async function cursorHooksAllow(check: PermissionCheck): Promise<boolean> {
  if (!getSetting<boolean>('cursorHooksEnabled', false)) return true
  const mapped = cursorHookForTool(check.toolName, check.args)
  if (!mapped) return true

  const workspaceRoot = getWorkspaceRoot()
  const decision = await runPermissionHooks(mapped.event, mapped.payload, {
    workspaceRoot,
    projectTrusted: isWorkspaceTrusted(workspaceRoot),
  })
  if (decision.permission === 'deny') {
    console.warn(
      `[cursor-hooks] ${mapped.event} denied ${check.toolName}` +
        (decision.agentMessage ? `: ${decision.agentMessage}` : ''),
    )
    return false
  }
  return true
}

/**
 * Returns true when the tool call may proceed, false when the user rejected.
 *
 * This gate is default-allow: only the tools matched below (shell, MCP, web
 * fetch/search, browser navigation) are explicitly gated, and anything else
 * falls through to `return true`. That is safe only because every *mutating*
 * tool is gated elsewhere — file writes/edits/deletes/renames go through the
 * diff-approval queue (see diff-queue.ts), not this function. Any new tool that
 * changes the workspace or reaches the network MUST either route through the
 * diff queue or get an explicit case here; do not rely on the default branch.
 */
export async function ensureToolPermitted(check: PermissionCheck): Promise<boolean> {
  const { toolName, args } = check

  if (!(await cursorHooksAllow(check))) return false

  // Read-only runs block mutating tools and any MCP tool not provably read-only.
  // Allowed tools fall through to the normal gates below — read-only mode never
  // auto-approves a tool that would otherwise prompt.
  if (isAgentRunReadonly()) {
    const blocked = getReadonlyToolBlockReason(toolName, {
      mcpAnnotations: toolName.startsWith('mcp__')
        ? getMcpToolMeta(toolName)?.annotations
        : undefined,
    })
    if (blocked) return false
  }

  if (SANDBOX_TOOLS.has(toolName)) return true

  if (toolName === 'browser_navigate') {
    return checkBrowserNavigatePermission(args)
  }
  // Snapshot/screenshot/click/type act on the already-approved page; auto-run.
  if (BROWSER_TOOLS.has(toolName) || READ_ONLY_BROWSER_TOOLS.has(toolName)) {
    return true
  }

  if (toolName === 'fetch_url') {
    return checkFetchUrlPermission(args)
  }

  if (toolName === 'web_search') {
    return checkWebSearchPermission()
  }

  // Read-only GitHub CI reads (status/logs/wait) reach github.com via the `gh`
  // CLI but never mutate anything — the same shape as gh_pr_view in SANDBOX_TOOLS.
  // They auto-run without prompting; nothing they do needs user approval.
  if (GITHUB_READONLY_CI_TOOLS.has(toolName)) {
    return true
  }

  if (toolName.startsWith('mcp__')) {
    return checkMcpPermission(toolName, args)
  }

  if (toolName.startsWith(CUSTOM_TOOL_PREFIX)) {
    return checkCustomToolPermission(toolName, args)
  }

  if (toolName === 'run_shell') {
    return checkShellPermission(args)
  }

  if (toolName === 'run_background') {
    return checkBackgroundProcessPermission(args)
  }

  // Default-allow: read-only/in-process tools (and mutating tools that are
  // gated via the diff-approval queue) need no prompt here. See the contract
  // in this function's doc comment before relying on this branch for a new tool.
  return true
}
