import { getWorkspaceRoot } from './workspace.ts'
import { isProjectSandboxEnabled } from '../project-sandbox/index.ts'
import { classifyShellScope } from './safety-classifier.ts'
import { requestApproval } from './approval.ts'
import { getSetting } from './settings.ts'
import {
  SANDBOX_TOOLS,
  decideShellPermission,
  shellCommandFromArgs,
  formatShellPromptBody,
  mcpToolLabel,
} from './permission-policy.ts'
import { formatUnsandboxedPromptBody } from './sandbox-failure.ts'

export type { ShellPermissionDecision, PermissionCheck } from './permission-policy.ts'
export { decideShellPermission } from './permission-policy.ts'

import type { PermissionCheck } from './permission-policy.ts'

async function promptShell(command: string, reasons: string[]): Promise<boolean> {
  return requestApproval({
    title: 'Run shell command?',
    body: formatShellPromptBody(command, reasons),
    type: 'shell',
  })
}

/** Prompt when a sandboxed command failed and may succeed unsandboxed. */
export async function promptUnsandboxedShell(command: string, reasons: string[]): Promise<boolean> {
  return requestApproval({
    title: 'Run outside sandbox?',
    body: formatUnsandboxedPromptBody(command, reasons),
    type: 'shell',
  })
}

async function promptMcp(toolName: string, args: unknown): Promise<boolean> {
  return requestApproval({
    title: `MCP tool: ${mcpToolLabel(toolName)}`,
    body: JSON.stringify(args, null, 2),
    type: 'mcp',
  })
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

/** Returns true when the tool call may proceed, false when the user rejected. */
export async function ensureToolPermitted(check: PermissionCheck): Promise<boolean> {
  const { toolName, args } = check

  if (SANDBOX_TOOLS.has(toolName)) return true

  if (toolName.startsWith('mcp__')) {
    return promptMcp(toolName, args)
  }

  if (toolName === 'run_shell') {
    return checkShellPermission(args)
  }

  return true
}
