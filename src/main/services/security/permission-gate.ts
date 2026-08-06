import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { getWorkspaceRoot } from '../workspace.ts'
import { getAgentExecutionRoot, getAgentProjectRoot } from '../execution-root.ts'
import {
  getActiveExecutionTarget,
  isSshExecutionTarget,
} from '../ssh-workspace/execution-target.ts'
import { isWorkspaceTrusted } from './workspace-trust.ts'
import { runToolGateHooks, type HookGateDecision } from '../hooks/tool-gate.ts'
import { runPermissionDecisionHooks } from '../hooks/permission-decision.ts'
import { snapshotHookRunContext } from '../hook-run-recorder.ts'
import { haltRunFromBlockingHook } from '../hooks/halt-run.ts'
import { currentAgentSessionInfo } from '../hooks/agent-session.ts'
import { getActiveRunThread, getActiveRunTurnTreeId } from '../thread-models.ts'
import { getThreadExecutionContext } from '../thread-execution-context.ts'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type { HookDecision } from '@copse/agent/hooks/hook-outcome.ts'
import type { ShellPermissionDecision, ShellPromptParts } from './permission-policy.ts'
import { errorMessage } from '@shared/errors.ts'
import { nonEmptyStringOr } from '@shared/unknown-value.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/index.ts'
import { isSandboxNetworkScopeActive } from '../../project-sandbox/network-scope.ts'
import { acpBridgeNetworkScopeAlreadyApplies } from '../acp/acp-bridge-permission-context.ts'
import { classifyShellScope } from './safety-classifier.ts'
import { requestApproval } from '../approval.ts'
import { recordDecision } from './decision-log-store.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import {
  SANDBOX_TOOLS,
  decideShellPermission,
  decideTerminalPermission,
  decideMcpPermission,
  decideWebFetchPermission,
  decideWebSearchPermission,
  describeMcpAnnotations,
  fetchUrlFromArgs,
  formatWebPromptBody,
  shellCommandFromArgs,
  formatShellPromptParts,
  formatPortBindingPromptParts,
  backgroundAllowsPortBinding,
  backgroundCommandFromArgs,
  formatExternalSandboxPromptParts,
  formatExpectedSandboxBlockPromptParts,
  formatGuardedYoloHarmPromptAdvice,
  formatInstallPromptParts,
  formatEphemeralRunnerPromptParts,
  shellPromptToApprovalFields,
  shellRequiresOutsideSandbox,
  mcpToolLabel,
  GITHUB_READONLY_CI_TOOLS,
  GITHUB_WRITE_TOOLS,
  isReadOnlySimpleCommand,
} from './permission-policy.ts'
import { detectPackageInstall } from './safe-install.ts'
import {
  addTrustedShellCommand,
  offerableTrustedCommand,
  routeShellCommand,
} from './command-routing-config.ts'
import { resolveAutoApproval } from './auto-approval-config.ts'
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
import { formatUnsandboxedPromptParts } from './sandbox-failure.ts'
import {
  analyzeReadOutsideProject,
  formatReadOutsideProjectPromptParts,
  READ_OUTSIDE_PROJECT_TITLE,
} from './read-outside-project.ts'
import { grantReadOutsideProject, hasReadOutsideProjectGrant } from './read-outside-grant.ts'
import { getMcpToolMeta, isMcpToolRemembered, rememberMcpTool } from '../mcp/mcp-registry.ts'
import { CUSTOM_TOOL_PREFIX, customToolLabel } from '../mcp/custom-tools-config.ts'
import {
  customToolRequiresApproval,
  isCustomToolRemembered,
  rememberCustomTool,
} from '../mcp/custom-tools-registry.ts'
import { isAgentRunReadonly } from '../agent-run-readonly.ts'
import { getReadonlyToolBlockReason } from '@shared/tools/readonly-tools.ts'
import { SHELL_DECISION_SUBJECT } from '@shared/threads/decision-log.ts'
import { PARALLEL_SEARCH_API_URL } from '../parallel-search.ts'
import { getDefaultPackRegistry } from '@copse/agent/packs/default-pack-registry.ts'
import { LOOPBACK_BIND_PERMISSION } from '@copse/agent/packs/background-tasks-pack.ts'
import { assessShellHarm } from './shell-harm.ts'
import { currentRunUsesGuardedYolo } from './guarded-yolo.ts'
import { recordPermissionDecision } from './permission-audit.ts'
import {
  replayLeaseCore,
  shellReplayLeaseStore,
  type ShellReplayLeaseIdentity,
} from './capability-lease.ts'
import { commandName, shellSegments } from './shell-argv.ts'
import {
  analyzeShellCommand,
  dangerousInSandboxReasons,
  isReplayableOpaqueLocalExecution,
} from './shell-scope.ts'

const SANDBOX_REPLAY_LABEL = 'Allow retries for this task (up to 10, for 15 minutes)'
const EXTERNAL_REPLAY_LABEL = 'Allow retries outside the sandbox (up to 2, for 15 minutes)'

function issueShellReplayLease(identity: ShellReplayLeaseIdentity, command: string): void {
  const core = replayLeaseCore(command, (segment) =>
    leaseCompanionAllowed(segment, identity.executionRoot),
  )
  if (!core) return
  const lease = shellReplayLeaseStore.issue(identity, core)
  recordDecision({
    kind: 'shell',
    actor: 'user',
    verdict: 'approved',
    subject: SHELL_DECISION_SUBJECT,
    scope: identity.containment === 'external' ? 'external' : 'sandbox',
    remembered: false,
    reasons: ['bounded exact replay lease issued'],
    source: `turn-tree-capability-lease:${lease.id}`,
    projectId: identity.projectId,
    threadId: identity.threadId,
  })
}

export type { ShellPermissionDecision, PermissionCheck } from './permission-policy.ts'
export { decideShellPermission } from './permission-policy.ts'

import type { PermissionCheck } from './permission-policy.ts'

export interface ShellCommandPermissionOptions {
  sandboxEnabled?: boolean
  autoRun?: boolean
  networkScopeAlreadyApplies?: boolean
  executionRoot?: string | null
  projectRoot?: string | null
  /** Raw tool command before any blocking hook rewrite. */
  originalCommand?: string
  /** When aborted, pending approval prompts settle as denied and callers treat as cancelled. */
  signal?: AbortSignal
}

export interface TerminalPermissionOptions {
  sandboxEnabled?: boolean
  remoteTarget?: boolean
}

/**
 * Offer "always allow `<binary>` in trusted projects" on an escalation to run a
 * command outside the sandbox, when a single eligible binary is resolvable (see
 * offerableTrustedCommand). Ticking it appends that basename to the trusted
 * allow-list, so future runs skip the prompt and run unsandboxed via
 * routeShellCommand — the prompt-once path that replaces a separate remembered
 * list. Returns the approval, persisting the grant on approve+remember.
 */
/**
 * Whether the deterministic auto-approval classifier lets `command` run without a
 * prompt, recording the grant to the durable decision log when it does.
 *
 * Consulted at every point that would otherwise interrupt the user for a shell
 * command — the up-front gate AND both sandbox-escalation prompts. Covering the
 * escalations matters as much as the gate: on macOS a `git fetch` auto-runs
 * *inside* the seatbelt, fails on the denied network, and only then asks to retry
 * outside it. Recognising the shape up front but re-prompting on that retry would
 * leave the most common commands prompting exactly as before.
 *
 * @param scope where the grant applies, recorded so the log distinguishes a
 *   contained auto-approval from one that dropped containment.
 */
function autoApproveShell(
  command: string,
  scope: 'sandbox' | 'external',
  executionRoot?: string | null,
): boolean {
  const decision = resolveAutoApproval(command, executionRoot)
  if (decision.action !== 'auto-approve') return false
  recordDecision({
    kind: 'shell',
    actor: 'classifier',
    verdict: 'allowed',
    subject: SHELL_DECISION_SUBJECT,
    scope,
    reasons: [`tier ${decision.tier}`, ...decision.reasons],
    source: 'auto-approval',
  })
  return true
}

async function requestEscalationApproval(
  title: string,
  parts: ShellPromptParts,
  signal?: AbortSignal,
  leaseIdentity?: ShellReplayLeaseIdentity,
): Promise<boolean> {
  if (signal?.aborted) return false
  const trustable = offerableTrustedCommand(parts.command)
  const { approved, remember, grantScope } = await requestApproval(
    {
      title,
      type: 'shell',
      ...shellPromptToApprovalFields(parts),
      subject: SHELL_DECISION_SUBJECT,
      scope: 'external',
      allowRemember: trustable !== null,
      ...(trustable ? { rememberLabel: `Always allow \`${trustable}\` in trusted projects` } : {}),
      ...(leaseIdentity
        ? {
            allowTurnTreeLease: true,
            turnTreeLeaseLabel: EXTERNAL_REPLAY_LABEL,
            turnTreeLeaseDefault: false,
            turnTreeLeaseSubject: parts.command,
          }
        : {}),
    },
    signal,
  )
  if (approved && remember && trustable) await addTrustedShellCommand(trustable)
  if (approved && grantScope === 'turn-tree' && leaseIdentity) {
    issueShellReplayLease(leaseIdentity, parts.command)
  }
  return approved
}

/**
 * Handle a command that only *reads* paths outside the project, when we can
 * account for every path it touches (see `read-outside-project.ts`).
 *
 * Returns null when the command is not that shape, so the caller falls through
 * to its normal prompt. Otherwise the thread's standing grant answers it, or the
 * user is asked with the narrower read-access wording — where the primary button
 * grants the shape for the rest of the thread and the secondary one approves
 * just this command.
 *
 * Every outcome lands in the durable decision log, naming the paths that were at
 * stake. The grant itself is held in memory (`read-outside-grant.ts`) and dies
 * with the process, but the *decision* to make it is a permanent record: the
 * answered prompt writes `scope: external-read` with `remembered: true` for a
 * thread grant and `false` for a one-command approval, and each later command
 * the grant covers writes its own `verdict: allowed` line sourced to it. So the
 * log shows both that the user widened read access and everything that ran under
 * it — the in-memory ledger is the mechanism, not the record.
 */
async function resolveReadOutsideProject(
  command: string,
  workspaceRoot: string | null,
  contained: boolean,
  signal?: AbortSignal,
): Promise<boolean | null> {
  const analysis = analyzeReadOutsideProject(command, workspaceRoot, { contained })
  if (!analysis.eligible) return null

  // The one fact the durable log can carry about this command: the paths, never
  // the command line (see SHELL_DECISION_SUBJECT). Shared by the prompt's answer
  // and by every command a standing grant later covers, so both read alike.
  const reasons = [`reads outside the project: ${analysis.targets.join(', ')}`]

  const threadId = getActiveRunThread()
  if (hasReadOutsideProjectGrant(threadId)) {
    recordDecision({
      kind: 'shell',
      actor: 'user',
      verdict: 'allowed',
      subject: SHELL_DECISION_SUBJECT,
      scope: 'external-read',
      reasons,
      source: 'read-outside-grant',
    })
    return true
  }

  const { approved, remember } = await requestApproval(
    {
      title: READ_OUTSIDE_PROJECT_TITLE,
      type: 'shell',
      ...shellPromptToApprovalFields(formatReadOutsideProjectPromptParts(command, analysis)),
      subject: SHELL_DECISION_SUBJECT,
      scope: 'external-read',
      // Recorded with the answer, so the log line that carries `remembered: true`
      // also says what the user granted read access *to*.
      reasons,
      // The command is behind "Show details" so the question the user answers is
      // the scope one; the third button that approves only this command appears
      // with the details it refers to.
      collapseDetails: true,
      approveOnceLabel: 'Approve this command',
    },
    signal,
  )
  // A handler with no thread (headless/ACP) can hold no grant, so its approval
  // covers this command only.
  if (approved && remember && threadId) grantReadOutsideProject(threadId)
  return approved
}

async function promptShell(
  command: string,
  reasons: string[],
  outsideSandbox: boolean,
  signal?: AbortSignal,
  leaseIdentity?: ShellReplayLeaseIdentity,
): Promise<boolean> {
  if (signal?.aborted) return false
  // The trusted-command tick box only makes sense on an escalation to OUTSIDE the
  // sandbox (a trusted command runs unsandboxed); an in-sandbox prompt never offers it.
  if (outsideSandbox) {
    return requestEscalationApproval(
      'Run outside sandbox?',
      formatExternalSandboxPromptParts(command, reasons),
      signal,
      leaseIdentity,
    )
  }
  const { approved, grantScope } = await requestApproval(
    {
      title: 'Run shell command?',
      type: 'shell',
      ...shellPromptToApprovalFields(formatShellPromptParts(command, reasons)),
      subject: SHELL_DECISION_SUBJECT,
      scope: 'sandbox',
      // A sandboxed approval includes a bounded replay lease by default. The
      // prompt names the 10-retry/15-minute bound; outside-sandbox grants remain
      // explicit because they weaken containment.
      ...(leaseIdentity
        ? {
            allowTurnTreeLease: true,
            turnTreeLeaseLabel: SANDBOX_REPLAY_LABEL,
            turnTreeLeaseDefault: true,
            turnTreeLeaseSubject: command,
          }
        : {}),
    },
    signal,
  )
  if (approved && grantScope === 'turn-tree' && leaseIdentity) {
    issueShellReplayLease(leaseIdentity, command)
  }
  return approved
}

async function promptGuardedYoloHarm(command: string, reasons: string[]): Promise<boolean> {
  const { approved } = await requestApproval({
    title: 'Guarded YOLO safety check',
    body: command,
    bodyAdvice: formatGuardedYoloHarmPromptAdvice(reasons),
    type: 'shell',
    allowRemember: false,
  })
  return approved
}

const MAX_HARM_SCRIPT_BYTES = 256 * 1024

function readScriptForHarm(path: string): string | null {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_HARM_SCRIPT_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Prompt when a sandboxed command failed and may succeed unsandboxed.
 *
 * `readGrantApplied` says the failed run had already been given the read-access
 * relaxation for the paths it names. That command has now been contained with
 * exactly what the read grant promised and still hit the sandbox, so the grant
 * has been spent: it must not also auto-answer the full-escape question. Falling
 * through to "Run outside sandbox?" puts the escalation back in front of the
 * user, where a read grant silently approving writes and network never belonged.
 */
export async function promptUnsandboxedShell(
  command: string,
  reasons: string[],
  signal?: AbortSignal,
  opts: { readGrantApplied?: boolean } = {},
): Promise<boolean> {
  if (autoApproveShell(command, 'external')) return true
  // A command that failed inside the sandbox because it reads a file in the
  // user's home directory is the same read-access question as the up-front gate,
  // so a thread that already granted that scope should not be asked again.
  if (opts.readGrantApplied !== true) {
    // `contained: false`, unlike the up-front gate: approving HERE runs the
    // command outside the sandbox — that is the question being asked — so the
    // seatbelt the relaxed checks lean on will not exist. This path keeps the
    // strict allow-list, and only ever covers shapes that need no relaxation.
    const readOutside = await resolveReadOutsideProject(
      command,
      getAgentExecutionRoot(),
      false,
      signal,
    )
    if (readOutside !== null) return readOutside
  }
  return requestEscalationApproval(
    'Run outside sandbox?',
    formatUnsandboxedPromptParts(command, reasons),
    signal,
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
  signal?: AbortSignal,
): Promise<boolean> {
  if (autoApproveShell(command, 'external')) return true
  const { approved } = await requestApproval(
    {
      title: 'Run outside sandbox?',
      type: 'shell',
      ...shellPromptToApprovalFields(formatExpectedSandboxBlockPromptParts(command, reasons)),
      subject: SHELL_DECISION_SUBJECT,
      scope: 'external',
    },
    signal,
  )
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
    subject: toolName,
    scope: 'external',
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
    subject: origin,
    scope: 'external',
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

async function checkParallelSearchPermission(): Promise<boolean> {
  const saved = getSetting<string[] | null>(WEB_ALLOWED_ORIGINS_SETTING, null)
  const decision = decideWebFetchPermission({
    url: PARALLEL_SEARCH_API_URL,
    allowedOrigins: webAllowedOriginsWithDefaults(saved),
    allowUserApproval: getSetting<boolean>(WEB_ALLOW_USER_APPROVAL_SETTING, true),
  })
  if (decision.action === 'allow') return true
  if (decision.action === 'deny') {
    throw new Error(`Parallel Search access denied: ${decision.reasons.join('; ')}`)
  }
  return promptWebOrigin(
    decision.origin,
    'The objective and search queries will be sent to Parallel. Requests may consume paid API credits; Zero Data Retention depends on your Parallel account agreement.',
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
function firePermissionDecision(
  toolName: string,
  decision: HookDecision,
  roots: { executionRoot?: string | null; projectRoot?: string | null } = {},
): void {
  if (!getSetting<boolean>('cursorHooksEnabled', false)) return
  const workspaceRoot = roots.projectRoot ?? getAgentProjectRoot()
  const executionRoot = roots.executionRoot ?? getAgentExecutionRoot()
  const agentSession = currentAgentSessionInfo()
  const threadId = nonEmptyStringOr(
    agentSession.conversationId,
    nonEmptyStringOr(getActiveRunThread(), 'permission'),
  )
  const turnTreeId = asTurnTreeId(nonEmptyStringOr(agentSession.generationId, threadId))
  // Snapshot the recording context now, synchronously (decision 3/6): the
  // dispatch is detached and may settle after this turn's window closes.
  const recordingSnapshot = snapshotHookRunContext()
  void runPermissionDecisionHooks(toolName, decision, {
    threadId,
    turnTreeId,
    workspaceRoot,
    executionRoot,
    projectTrusted: isWorkspaceTrusted(workspaceRoot),
    agentSession,
    recordingSnapshot,
  }).catch((err: unknown) => {
    console.warn('[hooks] permissionDecision dispatch error:', errorMessage(err))
  })
}

async function checkShellPermission(args: unknown, originalCommand?: string): Promise<boolean> {
  const command = shellCommandFromArgs(args)
  if (!command) return promptShell('(invalid command)', ['missing command argument'], false)

  return ensureShellCommandPermitted(
    command,
    originalCommand !== undefined ? { originalCommand } : {},
  )
}

function activeShellReplayLeaseIdentity(
  executionRoot: string,
  containment: ShellReplayLeaseIdentity['containment'],
): ShellReplayLeaseIdentity | null {
  const context = getThreadExecutionContext()
  const turnTreeId = getActiveRunTurnTreeId()
  if (!context || !turnTreeId || context.root !== executionRoot) return null
  return {
    projectId: context.projectId,
    threadId: context.threadId,
    turnTreeId,
    executionRoot,
    containment,
  }
}

function outputTransformAllowed(segment: string, workspaceRoot: string): boolean {
  if (!isReadOnlySimpleCommand(segment)) return false
  return sandboxCommandNormallyAllowed(segment, workspaceRoot)
}

function leaseCompanionAllowed(segment: string, workspaceRoot: string): boolean {
  if (outputTransformAllowed(segment, workspaceRoot)) return true
  const variants = shellSegments(segment)
  if (variants.length === 0) return false
  return variants.every((argv) => {
    if (argv.length !== 2 || commandName(argv[0]) !== 'cd') return false
    const target = argv[1]
    if (!target || target.startsWith('-')) return false
    const resolvedTarget = resolve(workspaceRoot, target)
    return resolvedTarget === workspaceRoot
  })
}

function sandboxCommandNormallyAllowed(command: string, workspaceRoot: string): boolean {
  return (
    decideShellPermission(command, {
      workspaceRoot,
      sandboxEnabled: true,
      autoRun: true,
      classification: null,
    }).action === 'allow'
  )
}

/** Gate a raw shell command string through the same approval flow as run_shell. */
export async function ensureShellCommandPermitted(
  command: string,
  opts: ShellCommandPermissionOptions = {},
): Promise<boolean> {
  if (opts.signal?.aborted) return false
  const guardedYolo = currentRunUsesGuardedYolo(getActiveRunThread())
  // ASRT's network allowlist is process-global. While an ACP agent or a
  // port-binding background task has widened it, an otherwise-contained shell
  // command could inherit that egress. Suspend every auto-run path — including
  // explicit trusted-command routing — until the scope releases. Manual approval
  // is still available for deliberate overlapping work. (#803)
  //
  // Exception: the sandboxed ACP agent's own bridged `run_shell` / direct
  // execute path opts in via `networkScopeAlreadyApplies` (or the bridge ALS) —
  // that scope exists *for* those calls, so they must not see the overlap prompt.
  const shareActiveNetworkScope =
    opts.networkScopeAlreadyApplies === true || acpBridgeNetworkScopeAlreadyApplies()
  if (!guardedYolo && isSandboxNetworkScopeActive() && !shareActiveNetworkScope) {
    return promptShell(
      command,
      ['sandbox network access is temporarily widened for another process'],
      false,
      opts.signal,
    )
  }

  // Trusted-command fast path: a command whose every segment is either an
  // explicitly trusted (allow-listed) command or a trivially-safe prep step runs
  // with no prompt — the prompt-fatigue lever for unsandboxable-but-safe tools
  // (e.g. xcodebuild). routeShellCommand internally requires auto-run to be on
  // AND the workspace to be trusted, and never waives analysis for an untrusted
  // co-segment, so this can only fire for a genuinely safe command line.
  if (!guardedYolo && routeShellCommand(command).outcome === 'allow') return true

  const autoRun = opts.autoRun ?? getSetting<boolean>('autoRunSandboxCommands', true)
  const workspaceRoot = opts.executionRoot ?? getAgentExecutionRoot()
  const sandboxEnabled = opts.sandboxEnabled ?? isProjectSandboxEnabled()
  const classification = sandboxEnabled || guardedYolo ? null : await classifyShellScope(command)
  if (classification) {
    recordDecision({
      kind: 'classification',
      actor: 'classifier',
      verdict: 'classified',
      subject: SHELL_DECISION_SUBJECT,
      scope: classification.scope,
      confidence: classification.confidence,
      ...(classification.reason ? { reasons: [classification.reason] } : {}),
      source: 'safety-classifier',
    })
  }
  const harmDecision = guardedYolo
    ? assessShellHarm(command, {
        workspaceRoot,
        homeDir: homedir(),
        canonicalizePath: realpathSync.native,
        readScript: readScriptForHarm,
      })
    : undefined
  const decision = decideShellPermission(command, {
    workspaceRoot,
    sandboxEnabled,
    autoRun,
    classification,
    mode: guardedYolo ? 'guarded-yolo' : 'standard',
    ...(harmDecision ? { harmDecision } : {}),
    externalDenyThreshold: getSetting<number>('safetyExternalDenyThreshold', 1),
  })

  // F2: fire the canonical `permissionDecision` observation with the verdict
  // `decideShellPermission` produced (audit-trail-ready; feeds a future #840
  // subscriber). Fired here, right after the verdict, so it reflects the policy
  // decision itself rather than the downstream prompt result.
  firePermissionDecision('run_shell', shellVerdictToHookDecision(decision.action), {
    executionRoot: workspaceRoot,
    ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
  })

  const outsideSandbox =
    shellRequiresOutsideSandbox(command, workspaceRoot, sandboxEnabled) ||
    (guardedYolo && sandboxEnabled && routeShellCommand(command).outcome === 'allow')
  const auditGuardedYolo = (userResponse: 'approved' | 'declined' | 'not-required'): void => {
    if (!guardedYolo || !harmDecision) return
    const originalCommand = opts.originalCommand ?? command
    recordPermissionDecision({
      originalCommand,
      ...(originalCommand !== command ? { effectiveCommand: command } : {}),
      originalMode: 'guarded-yolo',
      effectiveMode: 'guarded-yolo',
      sandboxState: sandboxEnabled && !outsideSandbox ? 'project-sandbox' : 'unsandboxed',
      harmDecision: harmDecision.action,
      policyDecision: decision.action,
      reasons: decision.reasons,
      userResponse,
    })
  }

  if (decision.action === 'allow') {
    auditGuardedYolo('not-required')
    return true
  }

  // Strict-mode refusal: surface the reason to the agent rather than silently
  // returning false (which reads as a plain user rejection).
  if (decision.action === 'deny') {
    auditGuardedYolo('not-required')
    const policy = guardedYolo ? 'Guarded YOLO harm gate' : 'strict-mode safety policy'
    throw new Error(`Command blocked by ${policy}: ${decision.reasons.join('; ')}`)
  }

  if (guardedYolo) {
    const approved = await promptGuardedYoloHarm(command, decision.reasons)
    auditGuardedYolo(approved ? 'approved' : 'declined')
    return approved
  }

  // Auto-approval classifier. The policy has resolved to `prompt`, so this is the
  // single point where a bounded-risk shape can skip the interruption — it can
  // only ever turn a prompt into an allow, never widen an `allow` or soften a
  // `deny` (both returned above). Deterministic and fail-closed; see
  // auto-approval.ts for the enumerated shapes and the safety argument.
  if (autoApproveShell(command, outsideSandbox ? 'external' : 'sandbox', workspaceRoot)) return true

  // A user may explicitly authorize one constituent for bounded exact retries in
  // this human turn tree. Conservative top-level composition is allowed only
  // when every other constituent independently passes ordinary policy.
  const baseLeaseEligible =
    sandboxEnabled &&
    workspaceRoot !== null &&
    dangerousInSandboxReasons(command).length === 0 &&
    !detectPackageInstall(command).isInstall
  const externalReplayEligible =
    outsideSandbox && isReplayableOpaqueLocalExecution(analyzeShellCommand(command, workspaceRoot))
  const leaseCore =
    workspaceRoot === null
      ? null
      : replayLeaseCore(command, (segment) => leaseCompanionAllowed(segment, workspaceRoot))
  const leaseMatchEligible = baseLeaseEligible && (!outsideSandbox || externalReplayEligible)
  const leaseRoot = leaseMatchEligible ? workspaceRoot : null
  const leaseIdentity =
    leaseRoot !== null
      ? activeShellReplayLeaseIdentity(leaseRoot, outsideSandbox ? 'external' : 'project-sandbox')
      : null
  const leaseOfferIdentity = leaseCore !== null ? leaseIdentity : null
  if (leaseIdentity) {
    const match = shellReplayLeaseStore.consume(leaseIdentity, command, (segment) =>
      leaseCompanionAllowed(segment, leaseIdentity.executionRoot),
    )
    if (match.matched) {
      recordDecision({
        kind: 'shell',
        actor: 'system',
        verdict: 'allowed',
        subject: SHELL_DECISION_SUBJECT,
        scope: leaseIdentity.containment === 'external' ? 'external' : 'sandbox',
        reasons: [
          'bounded exact replay lease used',
          ...(match.companionSegments.length > 0
            ? ['composed shell constituents independently allowed']
            : []),
        ],
        source: `turn-tree-capability-lease:${match.leaseId}`,
        projectId: leaseIdentity.projectId,
        threadId: leaseIdentity.threadId,
      })
      return true
    }
  }

  // Reads of accountable paths outside the project ask the narrower read-access
  // question — and can be answered once for the whole thread — instead of the
  // worst-case "run outside sandbox" escape hatch. Checked on every platform:
  // off macOS `outsideSandbox` is false (there is no seatbelt to leave) but the
  // read is just as external, and the gate is the only boundary.
  // Ordered after the replay lease so a command the user already authorized for
  // exact retry in this turn tree is still replayed without a prompt: the lease
  // is a no-prompt fast path, whereas this gate may ask.
  // `contained` = the shell tool will run an approval of this contained rather
  // than unsandboxed, which is what lets the analysis relax its head allow-list.
  // Both of that path's conditions are already known here: the sandbox is on, and
  // a trusted command returned `allow` far above. Keep the two in step — a
  // relaxation approved here that the tool then declines to contain would run the
  // command unsandboxed on a read-shaped answer.
  const readOutside = await resolveReadOutsideProject(
    command,
    workspaceRoot,
    sandboxEnabled,
    opts.signal,
  )
  if (readOutside !== null) return readOutside

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
            type: 'shell',
            ...shellPromptToApprovalFields(
              formatEphemeralRunnerPromptParts(command, { outsideSandbox, safeInstall }),
            ),
            subject: SHELL_DECISION_SUBJECT,
            scope: outsideSandbox ? 'external' : 'sandbox',
          }
        : {
            title: 'Run package install?',
            type: 'shell',
            ...shellPromptToApprovalFields(
              formatInstallPromptParts(command, {
                outsideSandbox,
                safeInstall,
                jsManager: install.jsManager,
              }),
            ),
            subject: SHELL_DECISION_SUBJECT,
            scope: outsideSandbox ? 'external' : 'sandbox',
          },
      opts.signal,
    )
    return approved
  }

  return promptShell(
    command,
    decision.reasons,
    outsideSandbox,
    opts.signal,
    leaseOfferIdentity ?? undefined,
  )
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
    subject: url,
    scope: 'external',
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
 *
 * The loopback port-binding relaxation is an authority the `copse.background-tasks`
 * pack DECLARES (its `loopback-bind` permission, issue #1190). It is grantable
 * ONLY while the owning pack is enabled: disabling the pack revokes the
 * relaxation in the same atomic flag flip that unregisters `run_background`.
 */
async function checkBackgroundProcessPermission(
  args: unknown,
  originalCommand?: string,
): Promise<boolean> {
  // Only a `start` action carries a command; management actions leave it empty.
  const command = backgroundCommandFromArgs(args)
  if (command && !(await checkShellPermission(args, originalCommand))) return false

  if (!backgroundAllowsPortBinding(args)) return true

  if (!getDefaultPackRegistry().isPermissionDeclared(LOOPBACK_BIND_PERMISSION)) {
    throw new Error(
      'Loopback port binding is not available: the Background tasks pack ' +
        '(copse.background-tasks) is disabled, so its loopback-bind sandbox ' +
        'relaxation is revoked. Run the task without allow_port_binding, or ' +
        'enable the pack in Settings > Packs.',
    )
  }

  const root = getAgentExecutionRoot()
  if (!root) throw new Error('No workspace open.')

  const allowed = getSetting<string[]>(PORT_BINDING_ALLOWED_ROOTS_SETTING, [])
  if (allowed.includes(root)) return true

  const { approved, remember } = await requestApproval({
    title: 'Allow this project to bind a local port?',
    type: 'shell',
    ...shellPromptToApprovalFields(
      formatPortBindingPromptParts(root, backgroundCommandFromArgs(args)),
    ),
    allowRemember: true,
    rememberLabel: 'Always allow local port binding in this project',
  })
  if (approved && remember && !allowed.includes(root)) {
    await setSetting(PORT_BINDING_ALLOWED_ROOTS_SETTING, [...allowed, root])
  }
  return approved
}

/**
 * User-initiated integrated terminals always spawn outside the project seatbelt
 * (see terminal-service.ts). On platforms without an OS sandbox boundary, or
 * when an SSH-backed PTY necessarily runs outside the local seatbelt, opening
 * one is an explicit user decision. A new terminal also prompts while the
 * process-global sandbox network scope is widened, because an unsandboxed PTY
 * would inherit that temporary egress. Agent shell confinement stays on
 * run_shell / run_background. (#662, #803, #812)
 */
export async function ensureTerminalPermitted(
  opts: TerminalPermissionOptions = {},
): Promise<boolean> {
  if (!getWorkspaceRoot()) throw new Error('No workspace open.')
  const decision = decideTerminalPermission({
    sandboxEnabled: opts.sandboxEnabled ?? isProjectSandboxEnabled(),
    remoteTarget: opts.remoteTarget ?? isSshExecutionTarget(getActiveExecutionTarget()),
    networkScopeActive: isSandboxNetworkScopeActive(),
  })
  if (decision.action === 'allow') return true

  if (decision.reason === 'widened-network') {
    const { approved } = await requestApproval({
      title: 'Open terminal with widened network access?',
      body:
        'The project sandbox network is temporarily widened for another process. ' +
        'A new integrated terminal would inherit that network access until the scope closes.',
      type: 'shell',
      allowRemember: false,
    })
    return approved
  }

  if (decision.reason === 'remote-target') {
    const { approved } = await requestApproval({
      title: 'Open remote terminal?',
      body:
        'SSH-backed integrated terminals run outside the local project sandbox. ' +
        'Commands you run can access the configured remote account and network.',
      type: 'shell',
      allowRemember: false,
    })
    return approved
  }

  const { approved } = await requestApproval({
    title: 'Open unsandboxed terminal?',
    body:
      'The integrated terminal cannot be confined by the project sandbox on this platform. ' +
      'Commands you run in it can access your full user account, filesystem, and network.',
    type: 'shell',
    allowRemember: false,
  })
  return approved
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

/** Record non-allow hook verdicts to the durable decision log. */
function recordHookDecision(toolName: string, decision: HookGateDecision): void {
  if (decision.permission === 'allow') return
  recordDecision({
    kind: 'hook',
    actor: 'hook',
    verdict: decision.permission === 'deny' ? 'blocked' : 'ask',
    subject: toolName,
    ...(decision.agentMessage ? { reasons: [decision.agentMessage] } : {}),
    source: 'toolGate',
  })
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

  const workspaceRoot = getAgentProjectRoot()
  const executionRoot = getAgentExecutionRoot()
  const projectTrusted = isWorkspaceTrusted(workspaceRoot)

  const decision = await runToolGateHooks(
    { toolName: check.toolName, args: check.args },
    { workspaceRoot, executionRoot, projectTrusted, agentSession: currentAgentSessionInfo() },
  )
  recordHookDecision(check.toolName, decision)

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
    // Block the triggering call too: `haltRun` outranks everything (decision 12),
    // so the tool must not execute once before the abort is observed — regardless
    // of whether the hook also set `permission: 'deny'`.
    return { ok: false }
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
  const originalShellCommand =
    check.toolName === 'run_shell' || check.toolName === 'run_background'
      ? shellCommandFromArgs(check.args)
      : null
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

  if (toolName === 'parallel_search') {
    return checkParallelSearchPermission()
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
    return checkShellPermission(args, originalShellCommand ?? undefined)
  }

  if (toolName === 'run_background') {
    return checkBackgroundProcessPermission(args, originalShellCommand ?? undefined)
  }

  // Default-allow: read-only/in-process tools (and mutating tools that are
  // gated via the diff-approval queue) need no prompt here. See the contract
  // in this function's doc comment before relying on this branch for a new tool.
  return true
}
