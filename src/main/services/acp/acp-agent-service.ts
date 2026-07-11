import * as fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  PermissionOption,
  PermissionOptionKind,
  StopReason,
  Usage,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import type { LLMMessage, StreamChunk, UserContent } from '@shared/types'
import { errorMessage } from '@shared/errors.ts'
import { promptPayloadFromUserContent } from '@shared/remote-agent-stream.ts'
import { acpModelValue } from '@shared/acp.ts'
import {
  DEFAULT_STREAM_MAX_ATTEMPTS,
  sleepMs,
  streamRetryDelayMs,
} from '@copse/llm/stream-retry.ts'
import {
  listAcpAgentModels,
  runAcpSessionPrompt,
  willSandboxAcpAgent,
  type AcpAgentSpawnConfig,
  type AcpClientHandlers,
  type AcpModelSelector,
} from './acp-client.ts'
import { getAcpAgent, resolveAcpSandbox } from './acp-agent-registry.ts'
import { acquireAcpSession, disposeAcpSession } from './acp-session-pool.ts'
import { buildInvokedSkillsBlock } from '../skills/skill-prompt.ts'
import { listForwardableMcpServers } from '../mcp/mcp-registry.ts'
import type { ToolRegistry } from '../tool-registry.ts'
import { isAcpPermissionRemembered, rememberAcpPermission } from './acp-permission-grants.ts'
import { permissionKindLabel, presentPermissionRequest } from './acp-approval-presentation.ts'
import { isBridgedNativeToolTitle } from './acp-native-bridge.ts'
import { requestApproval } from '../approval.ts'
import {
  awaitStagedDiffDecision,
  captureWorktreeBaseline,
  listWorktreeChangesSince,
  stageDiff,
} from '../diff-queue.ts'
import { networkDenialMarker, networkDenialsSince } from '../../project-sandbox/network-scope.ts'
import { ensureWorktreeRecoverable, resetSessionBackup } from '../worktree-backup.ts'
import { getSetting } from '../storage/settings.ts'
import { detectLanguage } from '../language.ts'
import {
  getActiveProjectRoot,
  getWorkspaceRoot,
  resolveWorkspacePath,
  toRelativePath,
} from '../workspace.ts'

/**
 * Run a turn against an external ACP agent selected as `acp:<id>` in the model
 * picker (client role). This is the app-wiring layer over `acp-client.ts`: it
 * resolves the configured agent + workspace, flattens the prompt, and backs the
 * agent's client callbacks with Copse's own machinery so Copse keeps ownership of
 * the workspace and the approval UX even though the external agent runs the loop:
 *
 * - `session/request_permission` → the approval dialog (`approval.ts`)
 * - `fs/read_text_file`          → workspace-scoped read (path sandboxed)
 * - `fs/write_text_file`         → the diff-approval queue (`diff-queue.ts`),
 *   blocking the agent's write until the user approves or rejects.
 *
 * Sessions are persistent per thread (issue #605): the agent process and ACP
 * session live in `acp-session-pool.ts` across turns, so the agent keeps its
 * own memory (no transcript replay on reuse) and background helpers it spawned
 * survive between turns. History is replayed only into a fresh session — first
 * turn, config change, post-failure respawn, or idle-reap.
 */

export interface RunAcpAgentOptions {
  threadId: string
  agentId: string
  userPrompt: UserContent
  priorMessages: LLMMessage[]
  signal: AbortSignal
  onChunk: (chunk: StreamChunk) => void
  /**
   * Tool registry backing the native-tool MCP bridge (#602 tier 2). When
   * absent the bridge is not offered.
   */
  registry?: ToolRegistry
  /**
   * Model chosen in the picker (the `#<model>` half of `acp:<id>#<model>`).
   * Overrides the agent config's default `model` for this turn.
   */
  model?: string
  /**
   * Skills the user invoked this turn via `/skill-name`. Their SKILL.md bodies
   * are resolved against Copse's local registry and inlined into the forwarded
   * prompt: an external ACP agent keeps its own separate skill catalog and never
   * sees Copse's, so the instructions must travel with the turn rather than
   * relying on the agent to already know the skill.
   */
  invokedSkills?: string[]
}

export interface RunAcpAgentResult {
  stopReason: StopReason
  messages: LLMMessage[]
  /** Turn token usage the agent reported (ACP `PromptResponse.usage`), if any. */
  usage: { inputTokens: number; outputTokens: number }
}

/** Matches the ~4 chars/token heuristic used across the app (trim-history.ts). */
const CHARS_PER_TOKEN = 4

export interface AcpTurnUsage {
  inputTokens: number
  outputTokens: number
  /** True when counts were estimated locally because the agent didn't report usage. */
  estimated: boolean
}

/**
 * Resolve a turn's token usage: use the agent's reported `PromptResponse.usage`
 * when it has any tokens, else fall back to a ~4 chars/token estimate of the
 * prompt we sent and the text we received (flagged `estimated`). Pure, so the
 * fallback arithmetic is unit-tested without spawning an agent.
 */
export function acpTurnUsage(
  reported: { inputTokens?: number | null; outputTokens?: number | null } | null | undefined,
  promptText: string,
  responseText: string,
): AcpTurnUsage {
  const inputTokens = reported?.inputTokens ?? 0
  const outputTokens = reported?.outputTokens ?? 0
  if (inputTokens || outputTokens) return { inputTokens, outputTokens, estimated: false }
  return {
    inputTokens: Math.ceil(promptText.length / CHARS_PER_TOKEN),
    outputTokens: Math.ceil(responseText.length / CHARS_PER_TOKEN),
    estimated: true,
  }
}

/**
 * A failed ACP turn, carrying whatever the turn streamed before it died so the
 * caller can keep the partial assistant text in thread history and attribute
 * the (estimated) token spend instead of silently zeroing both. `message` is
 * the underlying failure's message so `classifyAgentError` still sees it.
 */
export class AcpTurnFailure extends Error {
  readonly partial: {
    assistantText: string
    usage: { inputTokens: number; outputTokens: number }
  }

  constructor(
    cause: unknown,
    partial: { assistantText: string; usage: { inputTokens: number; outputTokens: number } },
  ) {
    super(errorMessage(cause), { cause })
    this.name = 'AcpTurnFailure'
    this.partial = partial
  }
}

/**
 * A transient *provider* failure surfaced through the agent. External agents
 * relay provider errors as opaque JSON-RPC error text (no status code or SDK
 * error class to inspect, unlike `isRetryableStreamError`), so match the
 * transient signatures in the message: Anthropic 529/overloaded, rate limits,
 * and 5xx server errors.
 */
export function isTransientProviderError(err: unknown): boolean {
  const msg = errorMessage(err)
  if (/\boverloaded\b/i.test(msg)) return true
  if (/\brate[ _-]?limit/i.test(msg)) return true
  if (/\b(?:429|500|502|503|504|529)\b/.test(msg)) return true
  if (/server error/i.test(msg)) return true
  return false
}

/**
 * A dropped ACP *transport* — the connection closed or the agent process died
 * (crash, broken stdio pipe) rather than a provider hiccup. Kept distinct from
 * {@link isTransientProviderError} because the remedy differs: the failed
 * attempt disposes the dead session (see `attempt()` below), so the retry
 * respawns the agent and replays history into a fresh session instead of
 * re-driving a connection that no longer exists. This is the `"ACP connection
 * closed"` case that previously surfaced straight to the user with no retry.
 */
export function isAcpConnectionDropped(err: unknown): boolean {
  const msg = errorMessage(err)
  if (/connection (?:closed|reset|lost)/i.test(msg)) return true
  if (/\b(?:EPIPE|ECONNRESET)\b/.test(msg)) return true
  if (/premature close/i.test(msg)) return true
  if (/write after end/i.test(msg)) return true
  return false
}

/**
 * Retryability gate for ACP turn failures: a transient provider error or a
 * dropped connection. Either is safe to retry only because `runWithAcpRetry`
 * still requires `hasProgress()` to be false — a failure that arrives after
 * tool calls ran or text streamed is never re-run.
 */
export function isRetryableAcpError(err: unknown): boolean {
  return isTransientProviderError(err) || isAcpConnectionDropped(err)
}

/**
 * Retry a whole-turn ACP prompt on a retryable failure (a transient provider
 * error or a dropped connection — see {@link isRetryableAcpError}), mirroring
 * `yieldStreamWithRetry`'s guard: only attempts that made no visible progress
 * (`hasProgress()` false — no chunk reached the UI yet) are retried, so a
 * mid-turn failure never re-runs tool calls or duplicates streamed text.
 */
export async function runWithAcpRetry<T>(
  run: () => Promise<T>,
  opts: {
    signal: AbortSignal
    hasProgress: () => boolean
    maxAttempts?: number
    delayMs?: (err: unknown, attempt: number) => number
  },
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_STREAM_MAX_ATTEMPTS
  const delayMs = opts.delayMs ?? streamRetryDelayMs
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (err) {
      if (
        opts.signal.aborted ||
        opts.hasProgress() ||
        attempt >= maxAttempts - 1 ||
        !isRetryableAcpError(err)
      ) {
        throw err
      }
      try {
        await sleepMs(delayMs(err, attempt), opts.signal)
      } catch {
        // Aborted while backing off — surface the turn's own failure, not the
        // sleep's AbortError.
        throw err
      }
    }
  }
}

export async function runAcpAgentFromSettings(
  options: RunAcpAgentOptions,
): Promise<RunAcpAgentResult> {
  const agent = getAcpAgent(options.agentId)
  if (!agent) {
    throw new Error(
      `ACP agent "${options.agentId}" is not configured or is disabled. Add it in Settings → ACP agents.`,
    )
  }

  const cwd = getActiveProjectRoot() ?? getWorkspaceRoot()
  if (!cwd) {
    throw new Error('Open a folder before running an ACP agent so it has a workspace to act in.')
  }

  const sandbox = resolveAcpSandbox(agent)
  if (!promptPayloadFromUserContent(options.userPrompt).text.trim()) {
    throw new Error('ACP agent prompt cannot be empty.')
  }

  const model = options.model ?? agent.model
  // Hand the agent the user's MCP servers so its session mounts them itself
  // (issue #602, tier 1). Best-effort: a config-read failure downgrades the turn
  // to "no forwarded servers" instead of failing it.
  const mcpServers = await listForwardableMcpServers().catch(() => [])
  // No `model` and no `nativeBridge` here: the session pool owns the bridge
  // (it must exist before spawn for the seatbelt's loopback), and the model
  // switches live via session/set_config_option so it never forces a respawn.
  const spawnConfig: AcpAgentSpawnConfig = {
    command: agent.command,
    cwd,
    ...(agent.args ? { args: agent.args } : {}),
    ...(agent.env ? { env: agent.env } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(sandbox ? { sandbox } : {}),
  }

  // Accumulate streamed assistant text so the turn contributes to thread history
  // (the external agent owns the model loop, so this is the only transcript we
  // see) and so the next turn's preamble can replay it. `sawChunk` gates the
  // retry below: once anything reached the UI, re-running the turn would
  // duplicate streamed text and re-execute tool calls.
  let assistantText = ''
  let sawChunk = false
  const onChunk = (chunk: StreamChunk): void => {
    sawChunk = true
    if (chunk.type === 'text') assistantText += chunk.text
    options.onChunk(chunk)
  }

  // Writes that went through the diff queue this turn (canonical git-status
  // path shape). Anything else that changed on disk bypassed user approval and
  // is surfaced by the post-turn audit (issue #591).
  const queueWrites = new Set<string>()
  const handlers: AcpClientHandlers = {
    onChunk,
    requestPermission: (req) => respondToPermission(agent, req),
    readTextFile,
    writeTextFile: (req) => writeViaDiffQueue(req, options.signal, queueWrites),
  }
  // New turn: reset the restore point so this turn's first file-write approval
  // snapshots the user's current uncommitted work (see respondToPermission).
  resetSessionBackup()
  const baseline = await captureWorktreeBaseline()
  const denialMark = networkDenialMarker()

  // Resolve the invoked skills' full instructions here, in the GUI process,
  // against the same local registry the `/` picker used — so a skill the user
  // could pick is guaranteed to resolve — then inline it into the forwarded
  // prompt. The external ACP agent has its own separate skill catalog and never
  // receives Copse's, so shipping the SKILL.md body with the turn is the only
  // way the agent gets the instructions. Sent every turn a skill is invoked
  // (not gated on session freshness): the agent does not retain it across turns.
  const skillsBlock = await buildInvokedSkillsBlock(options.invokedSkills ?? [], {
    sandboxActive: willSandboxAcpAgent(sandbox),
  })

  // One attempt = acquire (reuse the thread's live session, or open a fresh
  // one), install this turn's handlers, prompt. History is replayed only into
  // a FRESH session — a reused one already has its own memory of the thread
  // (issue #605). A failed attempt disposes the session so the retry (and the
  // next turn) reopens cleanly with a full replay.
  let lastPrompt = ''
  const attempt = async (): Promise<{ stopReason: StopReason; usage?: Usage | null }> => {
    const { entry, fresh } = await acquireAcpSession({
      threadId: options.threadId,
      config: spawnConfig,
      registry: options.registry,
    })
    entry.open.handlers.current = handlers
    const prompt = buildAcpPrompt(options.userPrompt, fresh ? options.priorMessages : [], {
      sandboxed: willSandboxAcpAgent(sandbox),
      includeNotes: fresh,
      ...(skillsBlock ? { skills: skillsBlock } : {}),
    })
    lastPrompt = prompt
    try {
      return await runAcpSessionPrompt(entry.open, prompt, model, options.signal)
    } catch (err) {
      disposeAcpSession(options.threadId)
      throw err
    } finally {
      entry.lastUsedAt = Date.now()
    }
  }

  let stopReason: StopReason
  let usage: Usage | null | undefined
  try {
    ;({ stopReason, usage } = await runWithAcpRetry(attempt, {
      signal: options.signal,
      hasProgress: () => sawChunk,
    }))
  } catch (err) {
    // The turn died mid-flight. Attribute what it visibly consumed (estimated —
    // the agent never got to report usage) and hand the partial transcript to
    // the caller so history and the usage panel don't pretend it never ran.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated inside the onChunk callback above; TS narrows to the `false` initializer
    const turn = sawChunk ? acpTurnUsage(null, lastPrompt, assistantText) : null
    if (turn) {
      options.onChunk({
        type: 'usage',
        model: acpModelValue(options.agentId, options.model),
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        estimated: true,
      })
    }
    // A dead turn may still have written via its own shell before failing —
    // and a network denial is often WHY it died, so name the blocked hosts.
    emitNetworkDenialAudit(denialMark, options.onChunk)
    await emitBypassedWriteAudit(baseline, queueWrites, options.onChunk)
    throw new AcpTurnFailure(err, {
      assistantText,
      usage: turn
        ? { inputTokens: turn.inputTokens, outputTokens: turn.outputTokens }
        : { inputTokens: 0, outputTokens: 0 },
    })
  }

  emitNetworkDenialAudit(denialMark, options.onChunk)
  await emitBypassedWriteAudit(baseline, queueWrites, options.onChunk)

  // Attribute the external agent's token usage to this thread + model so it shows
  // in the usage panel, just like the built-in loop. ACP's `PromptResponse.usage`
  // is optional/experimental (e.g. Cursor's adapter omits it), so when it's absent
  // we fall back to a local ~4 chars/token estimate of what we sent and received —
  // flagged `estimated` so the panel can mark it as approximate.
  const turn = acpTurnUsage(usage, lastPrompt, assistantText)
  if (turn.inputTokens || turn.outputTokens) {
    options.onChunk({
      type: 'usage',
      model: acpModelValue(options.agentId, options.model),
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      ...(turn.estimated ? { estimated: true } : {}),
      ...(usage?.cachedReadTokens != null ? { cacheReadTokens: usage.cachedReadTokens } : {}),
      ...(usage?.cachedWriteTokens != null ? { cacheCreationTokens: usage.cachedWriteTokens } : {}),
    })
  }

  return {
    stopReason,
    messages: assistantText ? [{ role: 'assistant', content: assistantText }] : [],
    usage: { inputTokens: turn.inputTokens, outputTokens: turn.outputTokens },
  }
}

/**
 * Discover the models a configured ACP agent offers (for the settings picker).
 * Resolves the agent + workspace, then probes it via {@link listAcpAgentModels}.
 * Returns `null` when the agent is unknown/disabled or exposes no model selector.
 */
export async function listAcpModelsForAgent(agentId: string): Promise<AcpModelSelector | null> {
  const agent = getAcpAgent(agentId)
  if (!agent) return null
  const cwd = getActiveProjectRoot() ?? getWorkspaceRoot()
  if (!cwd) {
    throw new Error('Open a folder before detecting an ACP agent’s models.')
  }
  const sandbox = resolveAcpSandbox(agent)
  return listAcpAgentModels({
    command: agent.command,
    cwd,
    ...(agent.args ? { args: agent.args } : {}),
    ...(agent.env ? { env: agent.env } : {}),
    ...(sandbox ? { sandbox } : {}),
  })
}

/**
 * Map the external agent's `session/request_permission` to Copse's approval
 * dialog, then translate the user's yes/no back to one of the agent-provided
 * option ids, or `cancelled` when the agent offered no matching option.
 *
 * Requests whose (agent, tool kind) pair was granted "always allow" earlier are
 * approved without prompting; checking the dialog's remember box persists such
 * a grant and also answers with the agent's own `allow_always` option so the
 * agent-side session stops asking within the turn.
 */
/**
 * ACP tool kinds whose only effect is mutating files in the worktree, so a
 * worktree backup fully covers the risk. Shell (`execute`) and web (`fetch`) are
 * excluded: their side effects (deleting outside the tree, spending money,
 * sending data) are not undone by restoring a git snapshot.
 */
const WRITE_TOOL_KINDS = new Set(['edit', 'delete', 'move'])

async function respondToPermission(
  agent: { id: string; title: string },
  req: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  const kind = req.toolCall.kind ?? 'other'
  if (isAcpPermissionRemembered(agent.id, kind)) {
    return permissionResponseFor(req.options, true, { preferAlways: true })
  }
  // Copse's own bridged tools (gh_*/CI, semantic search, staged diffs, browser,
  // web fetch) reach the agent as an MCP server Copse mounts and *re-gates on
  // execution* — so this ACP prompt only duplicates that gate. Auto-approve when
  // the request is identifiably one of ours, so they sail through like the
  // native tools do. See isBridgedNativeToolTitle for why the title is a sound
  // (if best-effort) signal and why forgery isn't in scope.
  if (
    getSetting<boolean>('acpAutoApproveNativeBridgeTools', true) &&
    isBridgedNativeToolTitle(req.toolCall.title)
  ) {
    return permissionResponseFor(req.options, true)
  }
  // File-mutating kinds (edit/delete/move) are auto-approved once a durable
  // backup of the user's worktree exists — the same safety net the native tools
  // use. Nothing the agent overwrites is unrecoverable, so the per-edit modal
  // adds friction without adding protection. Shell/web/other still prompt: a
  // stash makes overwritten files recoverable, not a `rm -rf` or a network call.
  if (WRITE_TOOL_KINDS.has(kind) && getSetting<boolean>('acpAutoApproveEditsWithBackup', true)) {
    if (await ensureWorktreeRecoverable()) {
      return permissionResponseFor(req.options, true)
    }
  }
  const presentation = presentPermissionRequest(agent.title, req)
  const { approved, remember } = await requestApproval({
    ...presentation,
    allowRemember: true,
    rememberLabel: `Always allow ${agent.title} ${permissionKindLabel(kind)}`,
  })
  if (approved && remember) void rememberAcpPermission(agent.id, kind)
  return permissionResponseFor(req.options, approved, { preferAlways: approved && remember })
}

/**
 * Translate the user's approve/deny into one of the agent-provided option ids.
 * By default a one-shot option (`*_once`) wins over a remembered one
 * (`*_always`) since Copse asks per call; `preferAlways` flips that for grants
 * the user chose to remember. Falls back to `cancelled` when the agent offered
 * no option of the needed polarity.
 */
export function permissionResponseFor(
  options: PermissionOption[],
  approved: boolean,
  opts?: { preferAlways?: boolean },
): RequestPermissionResponse {
  const wanted: PermissionOptionKind[] = approved
    ? opts?.preferAlways
      ? ['allow_always', 'allow_once']
      : ['allow_once', 'allow_always']
    : ['reject_once', 'reject_always']
  const option = pickPermissionOption(options, wanted)
  return option
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

function pickPermissionOption(
  options: PermissionOption[],
  kinds: PermissionOptionKind[],
): PermissionOption | undefined {
  for (const kind of kinds) {
    const match = options.find((option) => option.kind === kind)
    if (match) return match
  }
  return undefined
}

/** Back `fs/read_text_file` with a workspace-scoped read (path sandbox enforced). */
async function readTextFile(req: ReadTextFileRequest): Promise<ReadTextFileResponse> {
  const absPath = resolveWorkspacePath(req.path)
  const content = await fsp.readFile(absPath, 'utf-8')
  return { content: sliceLines(content, req.line, req.limit) }
}

/**
 * ACP reads may request a 1-based start line and/or a max line count. Return the
 * whole file when neither is set; otherwise slice without dropping the file's
 * trailing newline semantics.
 */
export function sliceLines(content: string, line?: number | null, limit?: number | null): string {
  if ((line === undefined || line === null) && (limit === undefined || limit === null)) {
    return content
  }
  const lines = content.split('\n')
  const start = line && line > 0 ? line - 1 : 0
  const end = limit && limit > 0 ? start + limit : lines.length
  return lines.slice(start, end).join('\n')
}

/**
 * Surface files that changed on disk during an ACP turn without passing through
 * the diff-approval queue (issue #591) — e.g. writes from the agent's own shell,
 * which ACP gives Copse no way to intercept. Rendered as a synthetic tool card
 * so the warning stays out of the assistant text (and out of the next turn's
 * replayed transcript). Best-effort: an audit failure never fails the turn, and
 * a non-git workspace audits to silence.
 */
async function emitBypassedWriteAudit(
  baseline: Map<string, string>,
  queueWrites: ReadonlySet<string>,
  onChunk: (chunk: StreamChunk) => void,
): Promise<void> {
  let bypassed: string[]
  try {
    bypassed = (await listWorktreeChangesSince(baseline)).filter((p) => !queueWrites.has(p))
  } catch {
    return
  }
  if (bypassed.length === 0) return
  const id = `acp-edit-audit-${randomUUID()}`
  onChunk({
    type: 'tool_call',
    toolCall: { id, name: 'workspace_edit_audit', args: { files: bypassed } },
  })
  // Warn, don't revert: the change may be legitimate (the agent's own shell, a
  // formatter it ran) or external (another editor mid-turn) — the audit can't
  // tell, so it surfaces the fact and leaves the decision to the user.
  onChunk({
    type: 'tool_result',
    toolCallId: id,
    result:
      'Warning: these files changed on disk during the ACP turn outside the approved ' +
      "sphere — no diff was reviewed for them. The write came from the agent's own " +
      'tools (e.g. its shell) or from something else entirely:\n' +
      bypassed.map((p) => `- ${p}`).join('\n') +
      '\nReview them (e.g. git diff) before relying on the workspace state.',
    isError: false,
  })
}

/** Canonicalize to the git-status path shape used by the worktree baseline. */
function auditKey(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
}

/**
 * Name the network destinations the sandbox blocked during this turn — ASRT's
 * own 403 body doesn't say which host, which made allowlist gaps guesswork
 * (e.g. an agent's OAuth endpoint missing from `sandbox.allowedDomains`).
 * Denials are recorded globally, so the bracket can occasionally include a
 * concurrent contained command's denial; the copy stays honest about that.
 */
function emitNetworkDenialAudit(marker: number, onChunk: (chunk: StreamChunk) => void): void {
  const denied = networkDenialsSince(marker)
  if (denied.length === 0) return
  const hosts = [
    ...new Set(
      denied.map((denial) =>
        denial.port !== undefined ? `${denial.host}:${String(denial.port)}` : denial.host,
      ),
    ),
  ]
  const id = `acp-network-audit-${randomUUID()}`
  onChunk({
    type: 'tool_call',
    toolCall: { id, name: 'sandbox_network_audit', args: { blocked: hosts } },
  })
  onChunk({
    type: 'tool_result',
    toolCallId: id,
    result:
      'The sandbox blocked these network destinations while the turn ran:\n' +
      hosts.map((host) => `- ${host}`).join('\n') +
      "\nIf the agent needs one legitimately, add its domain to the agent's " +
      'sandbox.allowedDomains override in Settings → ACP agents.',
    isError: false,
  })
}

/**
 * Back `fs/write_text_file` by routing the write through the diff-approval queue
 * and blocking until the user decides. The external agent expects the write to be
 * durable on success, so a rejected/aborted decision is surfaced as an error.
 * Durable writes are recorded in `queueWrites` so the post-turn audit can tell
 * approved changes apart from ones that bypassed the queue.
 */
async function writeViaDiffQueue(
  req: WriteTextFileRequest,
  signal: AbortSignal,
  queueWrites: Set<string>,
): Promise<WriteTextFileResponse> {
  const absPath = resolveWorkspacePath(req.path)
  const relPath = toRelativePath(absPath)
  let before = ''
  try {
    before = await fsp.readFile(absPath, 'utf-8')
  } catch {
    // New file — staged against an empty baseline, matching the diff queue's
    // treatment of absent files.
  }

  await stageDiff(relPath, before, req.content, detectLanguage(relPath))
  const status = await raceDecisionAgainstAbort(relPath, signal)

  if (status === 'approved' || status === 'applied_directly') {
    queueWrites.add(auditKey(relPath))
    return {}
  }
  if (status === 'aborted') throw new Error(`Write to ${relPath} was cancelled before approval.`)
  if (status === 'error') throw new Error(`Write to ${relPath} failed while applying the change.`)
  throw new Error(`Write to ${relPath} was rejected by the user.`)
}

/**
 * Wait for the staged diff to be decided, but give up if the turn is aborted
 * (`session/cancel`) so the agent's write call doesn't hang after the process is
 * being torn down.
 */
function raceDecisionAgainstAbort(
  path: string,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof awaitStagedDiffDecision>> | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise((resolve) => {
    const onAbort = (): void => {
      resolve('aborted')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void awaitStagedDiffDecision(path).then((decision) => {
      signal.removeEventListener('abort', onAbort)
      resolve(decision)
    })
  })
}

/**
 * Steering prepended to every ACP prompt. Two failure modes it exists to
 * prevent, both observed dogfooding:
 *
 * - **Background work outliving the session** (issues #605/#588): since #621
 *   the agent process is pooled per thread and survives across turns, so
 *   background/async subagents DO deliver — but the pool reaps sessions after
 *   ~10 idle minutes and on app shutdown, so open-ended background work can
 *   still be lost. Steer toward bounded background tasks, not away from them.
 * - **Broad find/ls dumps burn the agent's own context/budget**: undirected
 *   sweeps stay in the session's context for its whole lifetime.
 */
export const ACP_TURN_PROMPT_NOTE =
  'Session notes: this session persists across turns, and background or async ' +
  'subagents survive the end of a turn — their results surface in the thread ' +
  'live as they complete, even while no turn is running. The session IS ' +
  'reaped after ~10 idle minutes or on app ' +
  'shutdown, so keep background work bounded rather than open-ended. Keep ' +
  'exploration lean: prefer targeted searches (specific paths, rg with globs) ' +
  'over broad find/ls directory dumps, and prefer the "copse" MCP tools (e.g. ' +
  'semantic_search) when available.'

/**
 * Steering prepended to the prompt when the agent process runs under the
 * workspace seatbelt (issue #590). A silent $TMPDIR redirect is not enough:
 * models habitually hardcode `/tmp`, which the seatbelt denies — and unlike
 * native run_shell there is no approve-to-run-unsandboxed path, so without
 * this note the agent walks into EPERMs that user approval cannot fix.
 */
export const ACP_SANDBOX_PROMPT_NOTE =
  'Environment note: this session runs inside a filesystem sandbox. Writes are ' +
  'allowed only inside the workspace and $TMPDIR; the system /tmp, the rest of ' +
  'the home directory, and most network destinations are blocked — approval ' +
  'prompts cannot override the sandbox, so do not retry blocked paths. Put ' +
  'scratch files in $TMPDIR or the workspace.'

/**
 * Flatten the user prompt to text. With persistent sessions (issue #605) the
 * transcript replay and the session notes are only needed when the session is
 * FRESH — a reused session already carries both in its own context, and
 * re-sending them every turn would waste the agent's tokens (`includeNotes:
 * false`, empty `priorMessages` on reuse). `sandboxed` turns additionally get
 * {@link ACP_SANDBOX_PROMPT_NOTE} so the agent knows its confines.
 */
export function buildAcpPrompt(
  userPrompt: UserContent,
  priorMessages: LLMMessage[],
  opts?: { sandboxed?: boolean; includeNotes?: boolean; skills?: string },
): string {
  const includeNotes = opts?.includeNotes ?? true
  const note = includeNotes
    ? ACP_TURN_PROMPT_NOTE + (opts?.sandboxed ? `\n\n${ACP_SANDBOX_PROMPT_NOTE}` : '') + '\n\n'
    : ''
  // `opts.skills` carries the invoked skills' instructions (already prefixed with
  // its own `---` separator by buildInvokedSkillsBlock). Attach it to the current
  // message so the agent reads the instructions alongside the invocation.
  const current = promptPayloadFromUserContent(userPrompt).text + (opts?.skills ?? '')
  const transcript = priorMessages.map(messageLine).filter(Boolean).join('\n')
  if (!transcript) return `${note}${current}`
  return (
    note +
    'You are continuing an existing Copse chat. Use the prior conversation below ' +
    'for context, then respond to the new message.\n\n' +
    `${transcript}\n\n--- New message ---\n${current}`
  )
}

function messageLine(message: LLMMessage): string {
  if (message.role === 'user') {
    const text = promptPayloadFromUserContent(message.content).text.trim()
    return text ? `User: ${text}` : ''
  }
  if (message.role === 'assistant' && typeof message.content === 'string') {
    const text = message.content.trim()
    return text ? `Assistant: ${text}` : ''
  }
  // System prompts, tool results, and raw assistant tool-call turns are dropped
  // to keep the handoff compact and free of local-only tooling noise.
  return ''
}
