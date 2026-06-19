import { analyzeShellCommand } from './shell-scope.ts'
import type { ClassificationResult } from './safety-classifier.ts'

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
  if (analysis.verdict === 'external') {
    return { action: 'prompt', reasons: analysis.reasons }
  }

  if (!opts.sandboxEnabled) {
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

  return { action: 'allow', reasons: analysis.reasons }
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
