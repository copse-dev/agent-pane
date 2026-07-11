import type { Codex, CodexOptions, Input, ThreadOptions } from '@openai/codex-sdk'
import type { LLMMessage, StreamChunk } from '@shared/types'
import {
  buildRemoteAgentContextPreamble,
  promptPayloadFromUserContent,
  type PromptPayload,
} from '@shared/remote-agent-stream.ts'
import {
  codexSdkEventToChunks,
  createCodexSdkStreamState,
  type CodexSdkStreamState,
} from '@shared/codex-sdk-stream.ts'
import { REMOTE_AGENT_MODEL_PREFIX, REMOTE_AGENT_PROVIDER_CODEX } from '@shared/remote-agent.ts'
import { resolveApiKey } from '../storage/settings.ts'
import { getCurrentBranchName } from '../github/git-service.ts'
import { getActiveProjectRoot, getWorkspaceRoot } from '../workspace.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import type { RemoteAgentRunOptions, RemoteAgentRunResult } from './remote-agent-shared.ts'

const CODEX_AGENT_SESSION_PREFIX = 'codex-agent-session:'

/**
 * Factory for the Codex SDK client, injected so tests drive a fake Thread without
 * spawning the real `codex` CLI. Production builds construct the real `Codex`.
 */
export type CreateCodex = (options: CodexOptions) => Codex
export interface CodexAgentDeps {
  createCodex?: CreateCodex
}

async function defaultCreateCodex(options: CodexOptions): Promise<Codex> {
  const { Codex } = await import('@openai/codex-sdk')
  return new Codex(options)
}

interface CodexAgentSession {
  v: 1
  provider: typeof REMOTE_AGENT_PROVIDER_CODEX
  /** SDK thread id (persisted so a follow-up resumes the same Codex thread). */
  threadId: string
  /** Working directory the Codex thread was started in. */
  workingDirectory: string
}

function sessionKey(threadId: string): string {
  return `${CODEX_AGENT_SESSION_PREFIX}${threadId}`
}

function readSession(threadId: string): CodexAgentSession | null {
  const raw = storageGet(sessionKey(threadId))
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<CodexAgentSession>
  if (
    value.v !== 1 ||
    typeof value.threadId !== 'string' ||
    typeof value.workingDirectory !== 'string' ||
    value.provider !== REMOTE_AGENT_PROVIDER_CODEX
  ) {
    return null
  }
  return value as CodexAgentSession
}

function writeSession(threadId: string, session: CodexAgentSession): void {
  storageSet(sessionKey(threadId), session)
}

export function clearCodexAgentSession(threadId: string): void {
  storageSet(sessionKey(threadId), null)
}

/**
 * Codex authenticates with a `CODEX_API_KEY` if set, otherwise the app's OpenAI
 * key. The key is passed straight to the SDK constructor (not via inherited env,
 * which the child-process env scrubber strips for LLM secrets).
 */
function resolveCodexApiKey(): string {
  const key = process.env['CODEX_API_KEY']?.trim() || resolveApiKey('openai')
  if (!key) {
    throw new Error(
      'Configure an OpenAI API key (or set CODEX_API_KEY) in Settings before using Codex.',
    )
  }
  return key
}

function resolveWorkingDirectory(): string {
  const root = getActiveProjectRoot() ?? getWorkspaceRoot()
  if (!root) {
    throw new Error(
      'Open a project folder before running Codex — it works in your local workspace.',
    )
  }
  return root
}

function toCodexInput(prompt: PromptPayload): Input {
  // The SDK takes images as local file paths; the app only has base64 data URLs
  // here, so this first cut sends text only. (Attachments still reach a local or
  // remote agent normally.)
  return prompt.text
}

async function buildFirstTurnInput(
  prompt: PromptPayload,
  priorMessages: LLMMessage[],
): Promise<Input> {
  let branch: string | null = null
  try {
    branch = await getCurrentBranchName()
  } catch (err) {
    console.warn('[codex-agent] branch lookup failed:', err)
  }
  const preamble = buildRemoteAgentContextPreamble({ priorMessages, branch })
  if (!preamble) return toCodexInput(prompt)
  return `${preamble}\n\n--- New message ---\n${prompt.text}`
}

function buildLaunchNotice(reused: boolean, workingDirectory: string): string {
  const verb = reused ? 'Continuing with' : 'Running'
  return (
    `_${verb} Codex locally in \`${workingDirectory}\` — Codex runs its own tools and ` +
    `edits files in this workspace directly._\n\n`
  )
}

function reportUsage(
  state: CodexSdkStreamState,
  onChunk: (chunk: StreamChunk) => void,
): { inputTokens: number; outputTokens: number } {
  const inputTokens = state.usage?.input_tokens ?? 0
  const outputTokens = state.usage?.output_tokens ?? 0
  if (inputTokens || outputTokens) {
    onChunk({
      type: 'usage',
      model: `${REMOTE_AGENT_MODEL_PREFIX}${REMOTE_AGENT_PROVIDER_CODEX}`,
      inputTokens,
      outputTokens,
    })
  }
  return { inputTokens, outputTokens }
}

/**
 * Run a single turn on OpenAI's Codex via the local `@openai/codex-sdk`. Unlike
 * the cloud remote agents (Cursor / Claude), Codex executes on this machine: it
 * spawns the `codex` CLI, runs its own tools, and edits files directly in the
 * active project's working directory. Mirrors the remote-agent adapter contract
 * (same options/result) so the dispatcher can route to it transparently.
 */
export async function runCodexAgentFromSettings(
  options: RemoteAgentRunOptions,
  deps: CodexAgentDeps = {},
): Promise<RemoteAgentRunResult> {
  const prompt = promptPayloadFromUserContent(options.userPrompt)
  if (!prompt.text.trim() && !prompt.images?.length) {
    throw new Error('Codex prompt cannot be empty.')
  }
  const apiKey = resolveCodexApiKey()
  const workingDirectory = resolveWorkingDirectory()

  // A prior session is only reusable if it was started in the same working
  // directory; otherwise start a fresh Codex thread for this workspace.
  const priorSession = readSession(options.threadId)
  const reusable = priorSession?.workingDirectory === workingDirectory ? priorSession : null

  const codex = deps.createCodex
    ? deps.createCodex({ apiKey })
    : await defaultCreateCodex({ apiKey })

  // Codex edits the workspace, so it needs write access to the mounted directory.
  const threadOptions: ThreadOptions = {
    workingDirectory,
    skipGitRepoCheck: true,
    sandboxMode: 'workspace-write',
    // The app has no interactive approval channel into a Codex turn, so it runs
    // autonomously (surfaced up front in the launch notice).
    approvalPolicy: 'never',
  }
  const thread = reusable
    ? codex.resumeThread(reusable.threadId, threadOptions)
    : codex.startThread(threadOptions)

  const input = reusable
    ? // The resumed thread already holds prior history, so a follow-up is just
      // the new message — no context preamble needed.
      toCodexInput(prompt)
    : await buildFirstTurnInput(prompt, options.priorMessages ?? [])

  options.onChunk({ type: 'text', text: buildLaunchNotice(reusable !== null, workingDirectory) })

  const state: CodexSdkStreamState = createCodexSdkStreamState()
  const { events } = await thread.runStreamed(input, { signal: options.signal })
  for await (const event of events) {
    for (const chunk of codexSdkEventToChunks(event, state)) options.onChunk(chunk)
    if (state.done) break
  }

  // Persist the SDK thread id (from the thread.started event, or the thread's own
  // id once populated) so the next turn resumes the same Codex conversation.
  const resolvedThreadId = state.threadId ?? thread.id ?? reusable?.threadId
  if (resolvedThreadId) {
    writeSession(options.threadId, {
      v: 1,
      provider: REMOTE_AGENT_PROVIDER_CODEX,
      threadId: resolvedThreadId,
      workingDirectory,
    })
  }

  const usage = reportUsage(state, options.onChunk)
  options.onChunk(
    state.terminalStatus ? { type: 'done', stopReason: state.terminalStatus } : { type: 'done' },
  )

  const assistantText = state.assistantText
  return {
    assistantText,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    messages: assistantText ? [{ role: 'assistant', content: assistantText }] : [],
  }
}
