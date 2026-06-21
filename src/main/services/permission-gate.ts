import { getWorkspaceRoot } from './workspace.ts'
import { isProjectSandboxEnabled } from '../project-sandbox/index.ts'
import { classifyShellScope } from './safety-classifier.ts'
import { requestApproval } from './approval.ts'
import { getSetting } from './settings.ts'
import {
  SANDBOX_TOOLS,
  decideShellPermission,
  decideMcpPermission,
  describeMcpAnnotations,
  shellCommandFromArgs,
  formatShellPromptBody,
  formatExternalSandboxPromptBody,
  shellRequiresOutsideSandbox,
  mcpToolLabel,
} from './permission-policy.ts'
import { formatUnsandboxedPromptBody } from './sandbox-failure.ts'
import { getMcpToolMeta, isMcpToolRemembered, rememberMcpTool } from './mcp-registry.ts'

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
    annotations: meta?.annotations,
    remembered: isMcpToolRemembered(toolName),
    autoAllowReadOnly: getSetting<boolean>('mcpAutoAllowReadOnly', false),
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
    confidenceThreshold: getSetting<number>('lmStudioSafetyConfidenceThreshold', 0.85),
  })

  if (decision.action === 'allow') return true
  return promptShell(
    command,
    decision.reasons,
    shellRequiresOutsideSandbox(command, workspaceRoot, sandboxEnabled),
  )
}

/** Integrated terminal is a direct user UI action; PTY always runs outside seatbelt (#180). */
export async function ensureTerminalPermitted(): Promise<boolean> {
  if (!getWorkspaceRoot()) throw new Error('No workspace open.')
  return true
}

/** Returns true when the tool call may proceed, false when the user rejected. */
export async function ensureToolPermitted(check: PermissionCheck): Promise<boolean> {
  const { toolName, args } = check

  if (SANDBOX_TOOLS.has(toolName)) return true

  if (toolName.startsWith('mcp__')) {
    return checkMcpPermission(toolName, args)
  }

  if (toolName === 'run_shell') {
    return checkShellPermission(args)
  }

  return true
}
