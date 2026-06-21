import { analyzeShellCommand, dangerousInSandboxReasons } from './shell-scope.ts'
import type { ClassificationResult } from './safety-classifier.ts'
import type { McpToolAnnotations } from '@shared/types/mcp.ts'

/** Tools that always auto-run (writes still go through the diff queue). */
export const SANDBOX_TOOLS = new Set([
  'read_file',
  'read_skill',
  'write_file',
  'str_replace',
  'list_dir',
  'search_code',
  'search_codebase',
  'semantic_search',
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
  // Destructive/resource-exhausting commands still prompt even when the OS sandbox
  // is active: seatbelt is containment (no network, no out-of-workspace FS), not a
  // licence to silently `rm -rf` the repo or fork-bomb the host (issue #103).
  const dangerous = dangerousInSandboxReasons(command)

  // Heuristic only — see shell-scope.ts; macOS seatbelt is the real boundary when enabled.
  // With macOS seatbelt active, sandbox-contained, non-destructive commands auto-run
  // inside the project sandbox. External commands (network, gh, git push, …) prompt
  // first, then run outside the sandbox. Destructive in-workspace commands also prompt.
  // If a sandbox-contained command still fails (e.g. Playwright), shell-tool offers a retry.
  if (opts.sandboxEnabled) {
    if (analysis.verdict === 'external') {
      return { action: 'prompt', reasons: analysis.reasons }
    }
    if (dangerous.length > 0) {
      return { action: 'prompt', reasons: dangerous }
    }
    return { action: 'allow', reasons: analysis.reasons }
  }

  if (analysis.verdict === 'external') {
    return { action: 'prompt', reasons: analysis.reasons }
  }
  if (dangerous.length > 0) {
    return { action: 'prompt', reasons: dangerous }
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

export function formatExternalSandboxPromptBody(command: string, reasons: string[]): string {
  const detail = reasons.length ? reasons.join('; ') : 'network or outside-workspace access'
  return (
    `This command needs access the macOS project sandbox blocks (${detail}).\n\n` +
    `${command}\n\n` +
    `Allow running it once outside the sandbox?`
  )
}

/** True when macOS seatbelt is active and the command heuristic is external (network, gh, …). */
export function shellRequiresOutsideSandbox(
  command: string,
  workspaceRoot: string | null,
  sandboxEnabled: boolean,
): boolean {
  return sandboxEnabled && analyzeShellCommand(command, workspaceRoot).verdict === 'external'
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
  /** The user previously chose "always allow" for this exact tool. */
  remembered: boolean
  /** Setting: auto-run tools the server flags as read-only. */
  autoAllowReadOnly: boolean
}

/**
 * Decide whether an MCP tool call may run without prompting. Destructive hints
 * always win over read-only auto-allow; remembering is an explicit user opt-in.
 */
export function decideMcpPermission(input: McpPermissionInput): McpPermissionDecision {
  if (input.remembered) {
    return { action: 'allow', reasons: ['previously allowed for this tool'] }
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
