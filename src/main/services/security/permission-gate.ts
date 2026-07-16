import { getWorkspaceRoot } from '../workspace.ts'
import { isWorkspaceTrusted } from './workspace-trust.ts'
import { runToolGateHooks, type HookGateDecision } from '../hooks/tool-gate.ts'
import { runPermissionDecisionHooks } from '../hooks/permission-decision.ts'
import { haltRunFromBlockingHook } from '../hooks/halt-run.ts'
import { currentAgentSessionInfo } from '../hooks/agent-session.ts'
import { getActiveRunThread } from '../thread-models.ts'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type { HookDecision } from '@copse/agent/hooks/hook-outcome.ts'
import type { ShellPermissionDecision } from './permission-policy.ts'
import { errorMessage } from '@shared/errors.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/index.ts'
import { isSandboxNetworkScopeActive } from '../../project-sandbox/network-scope.ts'
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
  formatExpectedSandboxBlockPromptBody,
  formatInstallPromptBody,
  formatEphemeralRunnerPromptBody,
  shellRequiresOutsideSandbox,
  mcpToolLabel,
  GITHUB_READONLY_CI_TOOLS,
  GITHUB_WRITE_TOOLS,
} from './permission-policy.ts'
import { detectPackageInstall } from './safe-install.ts'
import {
  addTrustedShellCommand,
  offerableTrustedCommand,
  routeShellCommand,
} from './command-routing-config.ts'
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

export interface ShellCommandPermissionOptions {
  sandboxEnabled?: boolean
  autoRun?: boolean
  networkScopeAlreadyApplies?: boolean
}

/**
 * Offer "always allow `<binary>` in trusted projects" on an escalation to run a
 * command outside the sandbox, when a single eligible binary is resolvable (see
 * offerableTrustedCommand). Ticking it appends that basename to the trusted
 * allow-list, so future runs skip the prompt and run unsandboxed via
 * routeShellCommand — the prompt-once path that replaces a separate remembered
 * list. Returns the approval, persisting the grant on approve+remember.
 */
async function requestEscalationApproval(
  command: string,
  title: string,
  body: string,
): Promise<boolean> {
  const trustable = offerableTrustedCommand(command)
  const { approved, remember } = await requestApproval({
    title,
    body,
    type: 'shell',
    allowRemember: trustable !== null,
    ...(trustable ? { rememberLabel: `Always allow \`${trustable}\` in trusted projects` } : {}),
  })
  if (approved && remember && trustable) await addTrustedShellCommand(trustable)
  return approved
}

async function promptShell(
  command: string,
  reasons: string[],
  outsideSandbox: boolean,
): Promise<boolean> {
  // The trusted-command tick box only makes sense on an escalation to OUTSIDE the
  // sandbox (a trusted command runs unsandboxed); an in-sandbox prompt never offers it.
  if (outsideSandbox) {
    return requestEscalationApproval(
      command,
      'Run outside sandbox?',
      formatExternalSandboxPromptBody(command, reasons),
    )
  }
  const { approved } = await requestApproval({
    title: 'Run shell command?',
    body: formatShellPromptBody(command, reasons),
    type: 'shell',
  })
  return approved
}

/** Prompt when a sandboxed command failed and may succeed unsandboxed. */
export async function promptUnsandboxedShell(command: string, reasons: string[]): Promise<boolean> {
  return requestEscalationApproval(
    command,
    'Run outside sandbox?',
    formatUnsandboxedPromptBody(command, reasons),
  )
}

/**
 * Prompt when the agent declared up front (via `expects_sandbox_block`) that it
 * expects an ambiguously-external command to be blocked, asking to run it outside
 * the sandbox before the first attempt instead of after a recorded block.
 */
export async function promptExpectedSandboxBlock(
  command: string,
  reasons: string[],
): Promise<boolean> {
  const { approved } = await requestApproval({
    title: 'Run outside sandbox?',
    body: formatExpectedSandboxBlockPromptBody(command, reasons),
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

/**
 * Mutating GitHub PR actions always prompt (issue #690 Q3). There is no
 * "remember" yet — the per-repo grant granularity is still an open question, so
 * every approve / merge-when-ready / mark-ready / rerun-CI call asks first.
 */
async function checkGithubWriteToolPermission(toolName: string, args: unknown): Promise<boolean> {
  const { approved } = await requestApproval({
    title: `GitHub action: ${toolName}`,
    body: JSON.stringify(args, null, 2),
    type: 'mcp',
    allowRemember: false,
  })
  return approved
}

/** Map a shell permission verdict onto the canonical {@link HookDecision} vocabulary. */
function shellVerdictToHookDecision(action: ShellPermissionDecision['action']): HookDecision {
  // `prompt` means the user is asked to confirm — the canonical `ask`.
  return action === 'prompt' ? 'ask' : action
}

/**
 * Fire the canonical `permissionDecision` event **after** a permission verdict
 * (F2, Copse-native; observation-only, decision 3). A clean seam an audit logger
 * (#840) can subscribe to — it can never change the verdict that already
 * happened. Detached: dispatched and never awaited, so observing a decision
 * cannot delay the tool. Gated behind `cursorHooksEnabled` (default off), the
 * same flag `applyToolGateHooks` uses; any dispatch error is swallowed.
 */
function firePermissionDecision(toolName: string, decision: HookDecision): void {
  if (!getSetting<boolean>('cursorHooksEnabled', false)) return
  const workspaceRoot = getWorkspaceRoot()
  const agentSession = currentAgentSessionInfo()
  const threadId = agentSession.conversationId || getActiveRunThread() || 'permission'
  const turnTreeId = asTurnTreeId(agentSession.generationId || threadId)
  void runPermissionDecisionHooks(toolName, decision, {
    threadId,
    turnTreeId,
    workspaceRoot,
    projectTrusted: isWorkspaceTrusted(workspaceRoot),
    agentSession,
  }).catch((err: unknown) => {
    console.warn('[hooks] permissionDecision dispatch error:', errorMessage(err))
  })
}

async function checkShellPermission(args: unknown): Promise<boolean> {
  const command = shellCommandFromArgs(args)
  if (!command) return promptShell('(invalid command)', ['missing command argument'], false)

  return ensureShellCommandPermitted(command)
}

/** Gate a raw shell command string through the same approval flow as run_shell. */
export async function ensureShellCommandPermitted(
  command: string,
  opts: ShellCommandPermissionOptions = {},
): Promise<boolean> {
  // ASRT's network allowlist is process-global. While an ACP agent or a
  // port-binding background task has widened it, an otherwise-contained shell
  // command could inherit that egress. Suspend every auto-run path — including
  // explicit trusted-command routing — until the scope releases. Manual approval
  // is still available for deliberate overlapping work. (#803)
  if (isSandboxNetworkScopeActive() && !opts.networkScopeAlreadyApplies) {
    return promptShell(
      command,
      ['sandbox network access is temporarily widened for another process'],
      false,
    )
  }

  // Trusted-command fast path: a command whose every segment is either an
  // explicitly trusted (allow-listed) command or a trivially-safe prep step runs
  // with no prompt — the prompt-fatigue lever for unsandboxable-but-safe tools
  // (e.g. xcodebuild). routeShellCommand internally requires auto-run to be on
  // AND the workspace to be trusted, and never waives analysis for an untrusted
  // co-segment, so this can only fire for a genuinely safe command line.
  if (routeShellCommand(command).outcome === 'allow') return true

  const autoRun = opts.autoRun ?? getSetting<boolean>('autoRunSandboxCommands', true)
  const workspaceRoot = getWorkspaceRoot()
  const sandboxEnabled = opts.sandboxEnabled ?? isProjectSandboxEnabled()
  const decision = decideShellPermission(command, {
    workspaceRoot,
    sandboxEnabled,
    autoRun,
    classification: sandboxEnabled ? null : await classifyShellScope(command),
    externalDenyThreshold: getSetting<number>('safetyExternalDenyThreshold', 1),
  })

  // F2: fire the canonical `permissionDecision` observation with the verdict
  // `decideShellPermission` produced (audit-trail-ready; feeds a future #840
  // subscriber). Fired here, right after the verdict, so it reflects the policy
  // decision itself rather than the downstream prompt result.
  firePermissionDecision('run_shell', shellVerdictToHookDecision(decision.action))

  if (decision.action === 'allow') return true

  // Strict-mode refusal: surface the reason to the agent rather than silently
  // returning false (which reads as a plain user rejection).
  if (decision.action === 'deny') {
    throw new Error(`Command blocked by strict-mode safety policy: ${decision.reasons.join('; ')}`)
  }

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
 * Gate the `run_background` tool. A start action's command is first put through
 * the *same* decision as run_shell: on macOS the seatbelt contains it (contained
 * commands auto-run), but off the OS sandbox `spawnBackgroundProcess` runs the
 * command through `/bin/sh -c` with no sandbox, so external/ambiguous commands
 * must prompt rather than silently execute. The list/logs/stop management actions
 * carry no command and are not gated. On top of that, opting into loopback port
 * binding prompts the first time per workspace, then remembers the grant — the
 * same prompt-once model as browser origins and MCP servers.
 */
async function checkBackgroundProcessPermission(args: unknown): Promise<boolean> {
  // Only a `start` action carries a command; management actions leave it empty.
  const command = backgroundCommandFromArgs(args)
  if (command && !(await checkShellPermission(args))) return false

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

/** Integrated terminal is a direct user UI action; PTY always runs outside seatbelt (#180). */
// eslint-disable-next-line @typescript-eslint/require-await -- part of the uniformly-async permission-gate API (awaited by the terminal IPC handler)
export async function ensureTerminalPermitted(): Promise<boolean> {
  if (!getWorkspaceRoot()) throw new Error('No workspace open.')
  return true
}

/**
 * Prompt the user to confirm a tool call a hook returned `ask` for — the same
 * approval path a policy `ask` uses (B4). The hook's `agentMessage` / `userMessage`
 * (if any) heads the prompt body so the user sees *why* the hook wants review.
 */
async function promptHookAsk(check: PermissionCheck, decision: HookGateDecision): Promise<boolean> {
  const detail = decision.agentMessage ?? decision.userMessage
  const bodyLines: string[] = []
  if (detail) bodyLines.push(detail, '')
  bodyLines.push(JSON.stringify(check.args, null, 2))
  const { approved } = await requestApproval({
    title: `Hook asks to confirm: ${check.toolName}`,
    body: bodyLines.join('\n'),
    type: check.toolName === 'run_shell' || check.toolName === 'run_background' ? 'shell' : 'mcp',
  })
  return approved
}

/**
 * Run the tool-gate hooks (Cursor `hooks.json` + Claude `.claude/settings.json`)
 * for this tool call, via the canonical `toolGate` event and its dialect adapters
 * (A2). Gated behind `cursorHooksEnabled` (default off) because honouring hooks
 * spawns user/project scripts on the agent's hot path; the same flag covers both
 * dialects (#639). Returns whether the call may proceed to Copse's own gate:
 *
 *   - **deny** — the call is blocked. A message-bearing deny *throws* so the
 *     hook's reason reaches the model as the tool result (the existing
 *     agent-visible deny path, same as a strict-mode / web deny); a bare deny
 *     returns false, which the tool loop renders as the plain user rejection.
 *   - **ask** — escalates to Copse's approval prompt (never a silent allow/deny,
 *     B4). Approval falls through to the normal gate; a decline blocks the call.
 *   - **allow** — falls through: a hook can only *tighten* the gate, never
 *     auto-approve something Copse would otherwise prompt about.
 *
 * A hook may also **rewrite** the tool input (`updatedInput`, H1). The rewrite
 * is returned here (not applied yet); {@link ensureToolPermitted} applies it and
 * lets the downstream policy gates (`analyzeShellCommand` / `decideShellPermission`)
 * re-run on the rewritten input — a rewrite is never trusted without re-analysis.
 */
interface ToolGateHookOutcome {
  /** Whether the call may proceed to Copse's own gate (false = blocked). */
  ok: boolean
  /** Final hook-rewritten tool input (H1), when the pipeline rewrote it. */
  updatedInput?: Record<string, unknown>
  /**
   * Current-turn system-reminder block a hook injected (H2), already 10k-capped.
   * Carried only on a proceeding gate; {@link ensureToolPermitted} stamps it onto
   * the check so the tool runner appends it to the result.
   */
  injectContext?: string
}

async function applyToolGateHooks(check: PermissionCheck): Promise<ToolGateHookOutcome> {
  if (!getSetting<boolean>('cursorHooksEnabled', false)) return { ok: true }

  const workspaceRoot = getWorkspaceRoot()
  const projectTrusted = isWorkspaceTrusted(workspaceRoot)

  const decision = await runToolGateHooks(
    { toolName: check.toolName, args: check.args },
    { workspaceRoot, projectTrusted, agentSession: currentAgentSessionInfo() },
  )

  // H3 (decision 12): a `haltRun` stops the whole turn, not just this tool call.
  // Route it through the run's abort path — attributed to the hook, spine-recorded
  // — in addition to blocking the call below. A blocking hook fires synchronously
  // inside the active run, so it is current by construction (no epoch to be stale
  // against, decision 16); when no run is active this is a harmless no-op.
  if (decision.haltRun) {
    const threadId = getActiveRunThread()
    if (threadId) {
      haltRunFromBlockingHook({
        threadId,
        event: 'toolGate',
        hookId: decision.haltRun.hookId,
        reason: decision.haltRun.reason,
      })
    }
  }

  if (decision.permission === 'deny') {
    if (decision.agentMessage) {
      // Surface the hook's message to the agent via the tool-result error path.
      throw new Error(`Blocked by a hook: ${decision.agentMessage}`)
    }
    console.warn(`[hooks] toolGate denied ${check.toolName}`)
    return { ok: false }
  }

  const rewrite = decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : {}
  // H2: a proceeding gate may also carry current-turn injected context.
  const inject =
    decision.injectContext !== undefined ? { injectContext: decision.injectContext } : {}

  if (decision.permission === 'ask') {
    const approved = await promptHookAsk(check, decision)
    if (approved) return { ok: true, ...rewrite, ...inject }
    if (decision.agentMessage) throw new Error(`Blocked by a hook: ${decision.agentMessage}`)
    return { ok: false }
  }

  return { ok: true, ...rewrite, ...inject }
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
  const gate = await applyToolGateHooks(check)
  if (!gate.ok) return false

  // H1: a hook rewrote the tool input. Apply the rewrite *in place* so (a) the
  // policy gates below re-run `analyzeShellCommand` / `decideShellPermission` on
  // the rewritten input — a rewrite that turns a contained command into an
  // external one is caught by the matrix, never auto-allowed — and (b) the tool
  // executes with the rewritten input (ToolRegistry passes a fresh parsed-args
  // object, so mutating it is safe and is what carries the rewrite to execute()).
  if (gate.updatedInput && typeof check.args === 'object' && check.args !== null) {
    Object.assign(check.args, gate.updatedInput)
  }

  // H2: surface a hook's current-turn injected context on the check so the tool
  // runner appends it to this call's result (the fire-point injection). Set here
  // rather than acted on: the gate only decides *whether* to inject; the runner
  // owns *placing* it into the turn (ToolRegistry.execute).
  if (gate.injectContext !== undefined) check.injectContext = gate.injectContext

  const { toolName, args } = check

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

  // Mutating PR actions (approve / merge-when-ready / mark-ready / rerun CI)
  // change state on github.com, so they always prompt — never auto-run.
  if (GITHUB_WRITE_TOOLS.has(toolName)) {
    return checkGithubWriteToolPermission(toolName, args)
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
