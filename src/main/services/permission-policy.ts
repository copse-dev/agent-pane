import { analyzeShellCommand } from './shell-scope.ts'
import type { ClassificationResult } from './safety-classifier.ts'
import type { McpToolAnnotations } from '@shared/types/mcp.ts'

/** Tools that always auto-run (writes still go through the diff queue). */
export const SANDBOX_TOOLS = new Set([
  'read_file',
  'read_skill',
  'write_file',
  'list_dir',
  'search_code',
  'find_files',
  'git_status',
  'git_diff',
  'git_log',
])

export interface PermissionCheck {
  toolName: string
  args: unknown
}

export type ShellPermissionDecision =
  | { action: 'allow'; reasons: string[] }
  | { action: 'prompt'; reasons: string[] }

export function decideShellPermission(
  command: string,
  opts: {
    workspaceRoot: string | null
    sandboxEnabled: boolean
    autoRun: boolean
    classification: ClassificationResult | null
    confidenceThreshold: number
  },
): ShellPermissionDecision {
  if (!opts.autoRun) {
    return { action: 'prompt', reasons: ['auto-run for sandbox commands is disabled in Settings'] }
  }

  const analysis = analyzeShellCommand(command, opts.workspaceRoot)

  // With macOS seatbelt active, always try inside the project sandbox first.
  // If the command needs broader access, shell-tool offers a separate unsandboxed retry prompt.
  if (opts.sandboxEnabled) {
    return { action: 'allow', reasons: analysis.reasons }
  }

  if (analysis.verdict === 'external') {
    return { action: 'prompt', reasons: analysis.reasons }
  }

  const { classification, confidenceThreshold } = opts
  if (
    classification &&
    classification.scope === 'sandbox' &&
    classification.confidence >= confidenceThreshold
  ) {
    return { action: 'allow', reasons: [classification.reason] }
  }
  const reasons = classification
    ? [
        `safety model: ${classification.reason} (confidence ${classification.confidence.toFixed(2)})`,
      ]
    : ['OS sandbox unavailable — prompt required']
  return { action: 'prompt', reasons }
}

export function shellCommandFromArgs(args: unknown): string | null {
  if (typeof args !== 'object' || args === null || !('command' in args)) return null
  const cmd = (args as { command?: unknown }).command
  return typeof cmd === 'string' ? cmd : null
}

export function formatShellPromptBody(command: string, reasons: string[]): string {
  const detail = reasons.length ? `\n\nReason: ${reasons.join('; ')}` : ''
  return `${command}${detail}`
}

export function mcpToolLabel(toolName: string): string {
  const parts = toolName.split('__')
  if (parts[0] === 'mcp' && parts.length >= 3) {
    return `${parts[1]}/${parts.slice(2).join('__')}`
  }
  return toolName
}

export type McpPermissionDecision =
  | { action: 'allow'; reasons: string[] }
  | { action: 'prompt'; reasons: string[] }

export interface McpPermissionInput {
  /** Server-reported annotation hints for the tool, if any. */
  annotations?: McpToolAnnotations | undefined
  /** The user explicitly marked the server as trusted in config. */
  trusted: boolean
  /** The user previously chose "always allow" for this exact tool. */
  remembered: boolean
  /** Setting: auto-run tools the server flags as read-only. */
  autoAllowReadOnly: boolean
}

/**
 * Decide whether an MCP tool call may run without prompting. Destructive hints
 * always win over read-only auto-allow; trust/remember are explicit user opt-ins.
 */
export function decideMcpPermission(input: McpPermissionInput): McpPermissionDecision {
  if (input.remembered) {
    return { action: 'allow', reasons: ['previously allowed for this tool'] }
  }
  if (input.trusted) {
    return { action: 'allow', reasons: ['server marked trusted in config'] }
  }

  const ann = input.annotations
  if (ann?.destructiveHint) {
    return { action: 'prompt', reasons: ['tool is flagged as destructive'] }
  }
  if (ann?.readOnlyHint && input.autoAllowReadOnly) {
    return { action: 'allow', reasons: ['tool is flagged read-only'] }
  }

  return { action: 'prompt', reasons: ['external MCP tool requires approval'] }
}

/** Build a human-readable list of annotation hints for the approval dialog. */
export function describeMcpAnnotations(ann: McpToolAnnotations | undefined): string[] {
  if (!ann) return []
  const hints: string[] = []
  if (ann.readOnlyHint) hints.push('Read-only')
  if (ann.destructiveHint) hints.push('Destructive')
  if (ann.openWorldHint) hints.push('May access external systems')
  return hints
}
