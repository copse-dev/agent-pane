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
  'git_show',
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
  | { action: 'deny'; reasons: string[] }

export function decideShellPermission(
  command: string,
  opts: {
    workspaceRoot: string | null
    sandboxEnabled: boolean
    autoRun: boolean
    classification: ClassificationResult | null
    /** Min confidence for a `sandbox`-scoped classification to auto-run (default 0.85). */
    sandboxAllowThreshold: number
    /**
     * Strict-mode hard-deny bar: when the classifier is at least this confident a
     * command is `external` *and* a deterministic destructive signal fires, the
     * command is refused outright rather than surfaced for approval. Defaults to 1
     * (effectively off — only a certainty-1.0 verdict denies) so existing behaviour
     * is unchanged until the user lowers it. Never denies plain external work.
     */
    externalDenyThreshold?: number
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
  const { classification, sandboxAllowThreshold } = opts
  const externalDenyThreshold = opts.externalDenyThreshold ?? 1

  // Strict-mode hard-deny: refuse outright (no click-through) only when the safety
  // model is confident the command is external *and* a deterministic destructive
  // signal fires — "seems bad" by two independent measures. Checked before the
  // prompt branches so a deny always wins. Off by default (threshold 1).
  if (
    classification &&
    classification.scope === 'external' &&
    classification.confidence >= externalDenyThreshold &&
    dangerous.length > 0
  ) {
    return {
      action: 'deny',
      reasons: [
        `safety model flags dangerous external activity: ${classification.reason} ` +
          `(confidence ${classification.confidence.toFixed(2)})`,
        ...dangerous,
      ],
    }
  }

  if (analysis.verdict === 'external' || analysis.verdict === 'ambiguous') {
    return { action: 'prompt', reasons: analysis.reasons }
  }
  if (dangerous.length > 0) {
    return { action: 'prompt', reasons: dangerous }
  }

  if (
    classification &&
    classification.scope === 'sandbox' &&
    classification.confidence >= sandboxAllowThreshold
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

/** Read the `command` field of a run_background tool call. */
export function backgroundCommandFromArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null || !('command' in args)) return ''
  const command = (args as { command?: unknown }).command
  return typeof command === 'string' ? command : ''
}

/** Whether a run_background call opted into loopback port binding. */
export function backgroundAllowsPortBinding(args: unknown): boolean {
  if (typeof args !== 'object' || args === null || !('allow_port_binding' in args)) return false
  return (args as { allow_port_binding?: unknown }).allow_port_binding === true
}

export function formatPortBindingPromptBody(workspaceRoot: string, command: string): string {
  return (
    `The agent wants to start a long-running background task that binds a ` +
    `loopback port and stays alive across turns:\n\n${command || '(no command given)'}\n\n` +
    `Project: ${workspaceRoot}\n\n` +
    `It runs with the project's sandbox filesystem rules, relaxed only to allow ` +
    `binding on localhost.`
  )
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
 * Approval body when the agent asked up front (via `expects_sandbox_block`) to run
 * an ambiguously-external command outside the sandbox. Unlike the retry prompt,
 * this is NOT backed by a recorded sandbox violation — it is the agent's
 * expectation — so the wording says so plainly and invites more scrutiny.
 */
export function formatExpectedSandboxBlockPromptBody(command: string, reasons: string[]): string {
  const detail = reasons.length ? reasons.join('; ') : 'network or outside-workspace access'
  return (
    `The agent expects this command to need access the macOS project sandbox blocks ` +
    `(${detail}) and is asking to run it outside the sandbox up front, rather than ` +
    `letting it fail inside first.\n\n` +
    `${command}\n\n` +
    `This is the agent's expectation, not a confirmed sandbox block. ` +
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

/**
 * Whether the agent's up-front `expects_sandbox_block` hint may pull the
 * unsandboxed-escalation prompt forward for this command.
 *
 * Eligible ONLY for the `ambiguous` verdict — commands that would otherwise
 * auto-run inside seatbelt and escalate to an unsandboxed retry if the OS
 * actually blocked them (gh, cloud CLIs, ephemeral runners, nc). For those, the
 * hint just moves the same approval earlier, avoiding a partial in-sandbox run
 * before the retry. It is deliberately NOT honored for:
 *   - `external`: already prompts + runs outside up front, so there is nothing to
 *     pull forward, and
 *   - `sandbox`: no external signal at all — honoring a model-declared hint here
 *     would let it route a fully-contained command outside without a
 *     runner-verified block, the exact self-declared-escalation lever the retry
 *     path avoids (issues #103/#104). Such commands must still earn their escape
 *     from a real, non-forgeable sandbox violation, never the model's say-so.
 */
export function shellExpectedBlockEscalation(
  command: string,
  workspaceRoot: string | null,
  sandboxEnabled: boolean,
): { eligible: boolean; reasons: string[] } {
  if (!sandboxEnabled) return { eligible: false, reasons: [] }
  const analysis = analyzeShellCommand(command, workspaceRoot)
  if (analysis.verdict !== 'ambiguous') return { eligible: false, reasons: [] }
  return { eligible: true, reasons: analysis.reasons }
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

/**
 * The bare tool name with the `mcp__<server>__` prefix stripped. For a
 * non-prefixed name (or a malformed one) the input is returned unchanged.
 */
export function bareMcpToolName(toolName: string): string {
  const parts = toolName.split('__')
  if (parts[0] === 'mcp' && parts.length >= 3) {
    return parts.slice(2).join('__')
  }
  return toolName
}

/**
 * Leading verbs that make a tool name *structurally* read-only. These are the
 * standard read/query verbs used across MCP servers (e.g. `list_activities`,
 * `get_athlete_profile`, `search_code`, `read_file`) and match nothing that
 * mutates state. The set is intentionally tight — anything outside it prompts.
 */
const READ_ONLY_TOOL_NAME_VERBS = [
  'list',
  'get',
  'read',
  'search',
  'fetch',
  'describe',
  'show',
  'find',
  'query',
  'count',
] as const

/**
 * Whether a tool's NAME is structurally read-only: it begins with a known
 * read-only verb bounded by the end of the name, a `_`/`-` separator, a digit,
 * or a camelCase hump. So `get`, `get_x`, `get-x`, `getX` all qualify, but
 * `getaway` and `settings` do not.
 *
 * This is a *local* structural check, independent of any server-reported hint.
 * The auto-allow gate requires BOTH this and a read-only hint, so a compromised
 * server can no longer self-declare its way past the prompt with the hint alone.
 */
export function isStructurallyReadOnlyMcpToolName(toolName: string | undefined): boolean {
  if (!toolName) return false
  const name = bareMcpToolName(toolName).trim()
  if (!name) return false
  const lower = name.toLowerCase()
  return READ_ONLY_TOOL_NAME_VERBS.some((verb) => {
    if (!lower.startsWith(verb)) return false
    const rest = name.slice(verb.length)
    if (rest === '') return true
    const next = rest.charAt(0)
    return next === '_' || next === '-' || /[A-Z0-9]/.test(next)
  })
}

export type McpPermissionDecision =
  | { action: 'allow'; reasons: string[] }
  | { action: 'prompt'; reasons: string[] }

export interface McpPermissionInput {
  /** Full tool name (`mcp__<server>__<tool>`), used for the structural read-only name check. */
  toolName?: string | undefined
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
  // Auto-allow only when the tool NAME is structurally read-only AND the server
  // hint agrees. The name check is a local, non-forgeable gate: a compromised
  // server can no longer self-declare `readOnlyHint` to skip the prompt on a
  // mutating-named tool (issue #661). Anything else always prompts.
  if (ann?.readOnlyHint && input.autoAllowReadOnly) {
    if (isStructurallyReadOnlyMcpToolName(input.toolName)) {
      return { action: 'allow', reasons: ['read-only tool name and read-only hint'] }
    }
    return {
      action: 'prompt',
      reasons: ['read-only hint not corroborated by a read-only tool name'],
    }
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
