import { analyzeShellCommand, dangerousInSandboxReasons } from './shell-scope.ts'
import type { ClassificationResult } from './safety-classifier.ts'
import type { McpToolAnnotations } from '@shared/types/mcp.ts'
import { isWebOriginAllowed, parseFetchUrl, webOriginKey } from './web-origin-policy.ts'

/** Tools that always auto-run (writes still go through the diff queue). */
export const SANDBOX_TOOLS = new Set([
  'read_file',
  'read_skill',
  'write_file',
  'str_replace',
  'delete_file',
  'rename_file',
  'make_directory',
  'list_dir',
  'search_code',
  'search_codebase',
  'semantic_search',
  'find_files',
  'git_status',
  'git_diff',
  'git_log',
  'gh_pr_list',
  'gh_pr_view',
])

/**
 * Read-only GitHub CI tools. They reach github.com via the `gh` CLI but only
 * read CI status/logs (no mutation), so the gate auto-runs them without
 * prompting — same treatment as the read-only gh_pr_* tools in SANDBOX_TOOLS.
 */
export const GITHUB_READONLY_CI_TOOLS = new Set([
  'get_ci_status',
  'wait_for_ci_checks',
  'get_ci_failure_logs',
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
  // inside the project sandbox. Hard-external commands (network downloads, git push,
  // installs, outside-workspace FS) prompt first, then run outside the sandbox.
  // Ambiguous "may reach" matchers (gh, cloud CLI, nc, open-URL) auto-run *inside* the
  // sandbox: if seatbelt actually blocks them the command fails and shell-tool offers an
  // unsandboxed retry — so a grep over a `gh-*` path isn't gated on a guess, while a real
  // escape is still contained. Destructive in-workspace commands always prompt.
  if (opts.sandboxEnabled) {
    if (analysis.verdict === 'external') {
      return { action: 'prompt', reasons: analysis.reasons }
    }
    if (dangerous.length > 0) {
      return { action: 'prompt', reasons: dangerous }
    }
    return { action: 'allow', reasons: analysis.reasons }
  }

  // No OS sandbox: the heuristic is the only guard, so an ambiguous "may reach network"
  // verdict must prompt exactly like a hard-external one — auto-running it would be an
  // unprompted network/out-of-workspace call.
  if (analysis.verdict === 'external' || analysis.verdict === 'ambiguous') {
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

/**
 * Approval body for a detected package install. Installs always need the network,
 * so the generic "external command" reason list (and its nested parentheticals)
 * just adds noise — this states plainly that it's an install, where it runs, and
 * whether Socket Firewall will scan it.
 */
export function formatInstallPromptBody(
  command: string,
  opts: { outsideSandbox: boolean; safeInstall: boolean; jsManager: boolean },
): string {
  const access = opts.outsideSandbox
    ? 'It runs once outside the macOS sandbox with network access.'
    : 'It fetches packages over the network.'
  const scan = opts.safeInstall
    ? `Socket Firewall (sfw) scans the packages for known-malicious code${
        opts.jsManager ? ', and install lifecycle scripts are disabled' : ''
      }.`
    : 'Package scanning (Socket Firewall) is off in Settings, so packages run unscanned.'
  return [
    command.trim(),
    '',
    `This installs packages. ${access}`,
    '',
    scan,
    '',
    'Allow this install?',
  ].join('\n')
}

/**
 * Approval body for ephemeral package runners (npx). These may download and
 * execute code without adding dependencies to the project — different from a
 * persistent install, but still network + supply-chain sensitive.
 */
export function formatEphemeralRunnerPromptBody(
  command: string,
  opts: { outsideSandbox: boolean; safeInstall: boolean },
): string {
  const access = opts.outsideSandbox
    ? 'It runs once outside the macOS sandbox with network access.'
    : 'It may reach the network.'
  const scan = opts.safeInstall
    ? 'Socket Firewall (sfw) scans packages for known-malicious code.'
    : 'Package scanning (Socket Firewall) is off in Settings, so packages run unscanned.'
  return [
    command.trim(),
    '',
    `This may download and run code from the network. ${access}`,
    '',
    scan,
    '',
    'Allow this command?',
  ].join('\n')
}

/** True when macOS seatbelt is active and an approved shell command should bypass ASRT. */
export function shellRequiresOutsideSandbox(
  command: string,
  workspaceRoot: string | null,
  sandboxEnabled: boolean,
): boolean {
  if (!sandboxEnabled) return false
  return analyzeShellCommand(command, workspaceRoot).verdict === 'external'
}

export function shellSandboxFailureShouldOfferUnsandboxedRetry(
  command: string,
  workspaceRoot: string | null,
): boolean {
  const analysis = analyzeShellCommand(command, workspaceRoot)
  // sandbox/ambiguous commands ran *inside* seatbelt, so a sandbox-caused failure is
  // a genuine block worth retrying outside (e.g. `gh` denied network, Playwright FS).
  if (analysis.verdict !== 'external') return true
  // Hard-external commands already ran outside the sandbox, so only offer a retry for
  // filesystem-escape reasons; a network failure there isn't a sandbox artifact.
  return analysis.reasons.some((reason) => shellReasonRequiresOutsideSandbox(reason))
}

function shellReasonRequiresOutsideSandbox(reason: string): boolean {
  return /outside workspace|home directory|\$HOME|system path|global temp|parent directory|privilege escalation|process kill|system package manager|Homebrew/i.test(
    reason,
  )
}

export function mcpToolLabel(toolName: string): string {
  const parts = toolName.split('__')
  const server = parts[1]
  if (parts[0] === 'mcp' && parts.length >= 3 && server !== undefined) {
    return `${server}/${parts.slice(2).join('__')}`
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
  /**
   * The tool comes from one of Copse's own bundled in-process servers (e.g. the
   * canvas). These are first-party and sandboxed with no host access, so they
   * auto-run without prompting — there is no external party to approve.
   */
  bundled?: boolean
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
  // First-party bundled servers we ship are trusted; a destructive hint above
  // still prompts as a backstop, but otherwise they run without approval.
  if (input.bundled) {
    return { action: 'allow', reasons: ['first-party bundled tool'] }
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

export type WebPermissionDecision =
  | { action: 'allow'; origin: string; reasons: string[] }
  | { action: 'prompt'; origin: string; reasons: string[] }
  | { action: 'deny'; origin: string | null; reasons: string[] }

export function decideWebFetchPermission(input: {
  url: string
  allowedOrigins: readonly string[]
  allowUserApproval: boolean
}): WebPermissionDecision {
  let parsed: URL
  try {
    parsed = parseFetchUrl(input.url)
  } catch (error) {
    return {
      action: 'deny',
      origin: null,
      reasons: [error instanceof Error ? error.message : 'invalid URL'],
    }
  }

  const origin = webOriginKey(parsed)
  if (isWebOriginAllowed(parsed, input.allowedOrigins)) {
    return { action: 'allow', origin, reasons: ['origin is already allowed'] }
  }
  if (!input.allowUserApproval) {
    return { action: 'deny', origin, reasons: ['new web origin approvals are disabled'] }
  }
  return { action: 'prompt', origin, reasons: ['web origin requires approval'] }
}

export function decideWebSearchPermission(input: {
  allowedOrigins: readonly string[]
  allowUserApproval: boolean
}): WebPermissionDecision {
  return decideWebFetchPermission({
    url: 'https://duckduckgo.com/',
    allowedOrigins: input.allowedOrigins,
    allowUserApproval: input.allowUserApproval,
  })
}

export function fetchUrlFromArgs(args: unknown): string | null {
  if (typeof args !== 'object' || args === null || !('url' in args)) return null
  const url = (args as { url?: unknown }).url
  return typeof url === 'string' ? url : null
}

export function formatWebPromptBody(origin: string, detail: string): string {
  return [
    `The agent wants to access a web origin that is not in the allowlist:`,
    '',
    origin,
    '',
    detail,
    '',
    'Approve once, or check "Always allow" to add this origin to Settings.',
  ].join('\n')
}
