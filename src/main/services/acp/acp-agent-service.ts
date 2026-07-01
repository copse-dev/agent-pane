import * as fsp from 'node:fs/promises'
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  PermissionOption,
  PermissionOptionKind,
  StopReason,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import type { LLMMessage, StreamChunk, UserContent } from '@shared/types'
import { promptPayloadFromUserContent } from '@shared/remote-agent-stream.ts'
import { acpModelValue } from '@shared/acp.ts'
import {
  listAcpAgentModels,
  runAcpAgentPrompt,
  type AcpAgentSpawnConfig,
  type AcpClientHandlers,
  type AcpModelSelector,
} from './acp-client.ts'
import { getAcpAgent } from './acp-agent-registry.ts'
import { unwrapInlineCode } from './session-update-adapter.ts'
import { requestApproval } from '../approval.ts'
import { awaitStagedDiffDecision, stageDiff } from '../diff-queue.ts'
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
 * Each turn spawns a fresh agent process and a fresh ACP session — cross-turn
 * memory (session/resume) is a follow-up (issue #264, C2), so prior conversation
 * is replayed into the prompt as a compact preamble to preserve continuity.
 */

export interface RunAcpAgentOptions {
  threadId: string
  agentId: string
  userPrompt: UserContent
  priorMessages: LLMMessage[]
  signal: AbortSignal
  onChunk: (chunk: StreamChunk) => void
  /**
   * Model chosen in the picker (the `#<model>` half of `acp:<id>#<model>`).
   * Overrides the agent config's default `model` for this turn.
   */
  model?: string
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

  const prompt = buildAcpPrompt(options.userPrompt, options.priorMessages)
  if (!prompt.trim()) {
    throw new Error('ACP agent prompt cannot be empty.')
  }

  const model = options.model ?? agent.model
  const spawnConfig: AcpAgentSpawnConfig = {
    command: agent.command,
    cwd,
    ...(agent.args ? { args: agent.args } : {}),
    ...(agent.env ? { env: agent.env } : {}),
    ...(model ? { model } : {}),
  }

  // Accumulate streamed assistant text so the turn contributes to thread history
  // (the external agent owns the model loop, so this is the only transcript we
  // see) and so the next turn's preamble can replay it.
  let assistantText = ''
  const onChunk = (chunk: StreamChunk): void => {
    if (chunk.type === 'text') assistantText += chunk.text
    options.onChunk(chunk)
  }

  const handlers: AcpClientHandlers = {
    onChunk,
    requestPermission: (req) => respondToPermission(agent.title, req),
    readTextFile,
    writeTextFile: (req) => writeViaDiffQueue(req, options.signal),
  }

  const { stopReason, usage } = await runAcpAgentPrompt(
    spawnConfig,
    prompt,
    handlers,
    options.signal,
  )

  // Attribute the external agent's token usage to this thread + model so it shows
  // in the usage panel, just like the built-in loop. ACP's `PromptResponse.usage`
  // is optional/experimental (e.g. Cursor's adapter omits it), so when it's absent
  // we fall back to a local ~4 chars/token estimate of what we sent and received —
  // flagged `estimated` so the panel can mark it as approximate.
  const turn = acpTurnUsage(usage, prompt, assistantText)
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
  return listAcpAgentModels({
    command: agent.command,
    cwd,
    ...(agent.args ? { args: agent.args } : {}),
    ...(agent.env ? { env: agent.env } : {}),
  })
}

/**
 * Map the external agent's `session/request_permission` to Copse's approval
 * dialog, then translate the user's yes/no back to one of the agent-provided
 * option ids (preferring a one-shot option), or `cancelled` when the agent
 * offered no matching option.
 */
async function respondToPermission(
  agentTitle: string,
  req: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  const title = req.toolCall.title ? unwrapInlineCode(req.toolCall.title) : 'tool call'
  const { approved } = await requestApproval({
    title: `${agentTitle}: ${title}`,
    body: formatPermissionBody(req),
    type: 'mcp',
  })
  return permissionResponseFor(req.options, approved)
}

/**
 * Translate the user's approve/deny into one of the agent-provided option ids,
 * preferring a one-shot option (`*_once`) over a remembered one (`*_always`)
 * since Copse asks per call. Falls back to `cancelled` when the agent offered no
 * option of the needed polarity.
 */
export function permissionResponseFor(
  options: PermissionOption[],
  approved: boolean,
): RequestPermissionResponse {
  const wanted: PermissionOptionKind[] = approved
    ? ['allow_once', 'allow_always']
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

function formatPermissionBody(req: RequestPermissionRequest): string {
  const fallbackTitle = req.toolCall.title ? unwrapInlineCode(req.toolCall.title) : 'Run this tool call?'
  const input = req.toolCall.rawInput
  if (input === undefined || input === null) return fallbackTitle
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    // Non-serializable input (e.g. a circular structure); the title is enough
    // for the user to make an approval decision.
    return fallbackTitle
  }
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
 * Back `fs/write_text_file` by routing the write through the diff-approval queue
 * and blocking until the user decides. The external agent expects the write to be
 * durable on success, so a rejected/aborted decision is surfaced as an error.
 */
async function writeViaDiffQueue(
  req: WriteTextFileRequest,
  signal: AbortSignal,
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

  if (status === 'approved' || status === 'applied_directly') return {}
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
 * Flatten the user prompt to text, replaying prior conversation as a compact
 * preamble. A fresh ACP session has no memory of earlier turns, so without this
 * a follow-up message would reach the agent with no context.
 */
export function buildAcpPrompt(userPrompt: UserContent, priorMessages: LLMMessage[]): string {
  const current = promptPayloadFromUserContent(userPrompt).text
  const transcript = priorMessages.map(messageLine).filter(Boolean).join('\n')
  if (!transcript) return current
  return (
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
