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
  mcpToolLabel,
} from './permission-policy.ts'
import { formatUnsandboxedPromptBody } from './sandbox-failure.ts'
import { getMcpToolMeta, isMcpToolRemembered, rememberMcpTool } from './mcp-registry.ts'

export type { ShellPermissionDecision, PermissionCheck } from './permission-policy.ts'
export { decideShellPermission } from './permission-policy.ts'

import type { PermissionCheck } from './permission-policy.ts'

async function promptShell(command: string, reasons: string[]): Promise<boolean> {
  const { approved } = await requestApproval({
    title: 'Run shell command?',
    body: formatShellPromptBody(command, reasons),
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
  if (approved && remember) rememberMcpTool(toolName)
  return approved
}

async function checkShellPermission(args: unknown): Promise<boolean> {
  const command = shellCommandFromArgs(args)
  if (!command) return promptShell('(invalid command)', ['missing command argument'])

  const decision = decideShellPermission(command, {
    workspaceRoot: getWorkspaceRoot(),
    sandboxEnabled: isProjectSandboxEnabled(),
    autoRun: getSetting<boolean>('autoRunSandboxCommands', true),
    classification: isProjectSandboxEnabled() ? null : await classifyShellScope(command),
    confidenceThreshold: getSetting<number>('lmStudioSafetyConfidenceThreshold', 0.85),
  })

  if (decision.action === 'allow') return true
  return promptShell(command, decision.reasons)
}

const INTERACTIVE_TERMINAL_COMMAND = 'exec $SHELL'

/** Gate renderer terminal sessions with the same shell policy as run_shell. */
export async function ensureTerminalPermitted(): Promise<boolean> {
  const cwd = getWorkspaceRoot()
  if (!cwd) throw new Error('No workspace open.')

  const decision = decideShellPermission(INTERACTIVE_TERMINAL_COMMAND, {
    workspaceRoot: cwd,
    sandboxEnabled: isProjectSandboxEnabled(),
    autoRun: getSetting<boolean>('autoRunSandboxCommands', true),
    classification: isProjectSandboxEnabled()
      ? null
      : await classifyShellScope(INTERACTIVE_TERMINAL_COMMAND),
    confidenceThreshold: getSetting<number>('lmStudioSafetyConfidenceThreshold', 0.85),
  })

  if (decision.action === 'allow') return true
  return promptShell(INTERACTIVE_TERMINAL_COMMAND, decision.reasons)
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
