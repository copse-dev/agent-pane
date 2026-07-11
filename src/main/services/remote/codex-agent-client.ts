import type { LLMMessage, StreamChunk } from '@shared/types'
import {
  buildRemoteAgentContextPreamble,
  parseSseStream,
  promptPayloadFromUserContent,
  type PromptPayload,
} from '@shared/remote-agent-stream.ts'
import {
  createCodexAgentStreamState,
  codexAgentEventToChunks,
} from '@shared/codex-agents-stream.ts'
import {
  DEFAULT_CURSOR_AGENT_BASE_URL,
  DEFAULT_OPENAI_AGENT_BASE_URL,
  REMOTE_AGENT_MODEL_PREFIX,
  REMOTE_AGENT_PROVIDER_CODEX,
} from '@shared/remote-agent.ts'
import { getSetting, resolveApiKey } from '../storage/settings.ts'
import { validateRemoteAgentBaseUrl } from '../security/web-origin-policy.ts'
import { getCurrentBranchName } from '../github/git-service.ts'
import { getActiveProjectId } from '../workspace.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import {
  resolveRemoteAgentRepository,
  type RemoteAgentRunOptions,
  type RemoteAgentRunResult,
} from './remote-agent-shared.ts'
import { attachRemoteAgentPrFromText, recordRemoteAgentLaunch } from './remote-agent-link-store.ts'

const CODEX_AGENT_SESSION_PREFIX = 'codex-agent-session:'
// TODO(api-verify): Confirm the Codex Cloud beta header/version against the API
// before relying on task creation. Sent alongside the OpenAI Bearer key.
const CODEX_CLOUD_BETA = 'codex-cloud-2025-10-01'

interface CodexAgentSession {
  v: 1
  provider: typeof REMOTE_AGENT_PROVIDER_CODEX
  baseUrl: string
  taskId: string
  /** Web URL for the task (e.g. chatgpt.com/codex/tasks/...), shown in the transcript. */
  url?: string
}

interface CodexCreateTaskResponse {
  id?: string
  task?: { id?: string; url?: string }
  turn?: { id?: string }
  url?: string
}

interface CodexCreateTurnResponse {
  id?: string
  turn?: { id?: string }
}

interface CodexTurnGetResponse {
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
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
    typeof value.taskId !== 'string' ||
    typeof value.baseUrl !== 'string' ||
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

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'OpenAI-Beta': CODEX_CLOUD_BETA,
    'content-type': 'application/json',
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

/**
 * Resolve the Codex Cloud base URL. The base-URL setting is shared with Cursor
 * and defaults to Cursor's host, so an empty value or the literal Cursor default
 * both mean "use OpenAI's default" here; only a deliberately different custom
 * value (e.g. for API testing) is honored, after revalidation.
 */
function resolveCodexBaseUrl(): string {
  const raw = getSetting<string>('remoteAgentBaseUrl', '').trim()
  if (!raw || raw === DEFAULT_CURSOR_AGENT_BASE_URL) return DEFAULT_OPENAI_AGENT_BASE_URL
  validateRemoteAgentBaseUrl(raw)
  return raw
}

function resolveOpenAiApiKey(): string {
  const key = resolveApiKey('openai')
  if (!key) {
    throw new Error('Configure an OpenAI API key in Settings before using Codex Cloud Agent.')
  }
  return key
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `${label} failed with HTTP ${String(response.status)}${text ? `: ${text}` : ''}`,
    )
  }
  try {
    return (text ? JSON.parse(text) : {}) as T
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

function taskBody(input: {
  prompt: PromptPayload
  repository: string
  startingRef: string
}): string {
  return JSON.stringify({
    prompt: input.prompt,
    // Codex Cloud clones the source repo on its side (via the account's GitHub
    // connection), so there is no repo-less mode for this provider — the request
    // always carries a repository, like Cursor.
    repo: {
      url: input.repository,
      ...(input.startingRef ? { branch: input.startingRef } : {}),
    },
    auto_create_pr: getSetting<boolean>('remoteAgentAutoCreatePR', true),
    work_on_current_branch: getSetting<boolean>('remoteAgentWorkOnCurrentBranch', false),
  })
}

async function createTask(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  prompt: PromptPayload
  repository: string
  startingRef: string
}): Promise<{ taskId: string; turnId: string; url?: string }> {
  const response = await input.fetchImpl(joinUrl(input.baseUrl, '/v1/codex/tasks'), {
    method: 'POST',
    headers: authHeaders(input.apiKey),
    body: taskBody(input),
  })
  const json = await readJson<CodexCreateTaskResponse>(response, 'Codex Cloud Agent create')
  const taskId = json.task?.id ?? json.id
  const turnId = json.turn?.id ?? taskId
  const url = json.task?.url ?? json.url
  if (!taskId) throw new Error('Codex Cloud Agent create response did not include a task id')
  if (!turnId) throw new Error('Codex Cloud Agent create response did not include a turn id')
  return { taskId, turnId, ...(url ? { url } : {}) }
}

async function createTurn(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  taskId: string
  prompt: PromptPayload
}): Promise<string> {
  const response = await input.fetchImpl(
    joinUrl(input.baseUrl, `/v1/codex/tasks/${encodeURIComponent(input.taskId)}/turns`),
    {
      method: 'POST',
      headers: authHeaders(input.apiKey),
      body: JSON.stringify({ prompt: input.prompt }),
    },
  )
  const json = await readJson<CodexCreateTurnResponse>(response, 'Codex Cloud Agent follow-up')
  const turnId = json.turn?.id ?? json.id
  if (!turnId) throw new Error('Codex Cloud Agent follow-up response did not include a turn id')
  return turnId
}

async function cancelTask(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  taskId: string
}): Promise<void> {
  const response = await input.fetchImpl(
    joinUrl(input.baseUrl, `/v1/codex/tasks/${encodeURIComponent(input.taskId)}/cancel`),
    {
      method: 'POST',
      headers: authHeaders(input.apiKey),
    },
  )
  if (!response.ok && response.status !== 409) {
    const details = await response.text()
    throw new Error(
      `Codex Cloud Agent cancel failed with HTTP ${String(response.status)}${details ? `: ${details}` : ''}`,
    )
  }
}

async function fetchTurnUsage(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  taskId: string
  turnId: string
}): Promise<{ inputTokens: number; outputTokens: number }> {
  const response = await input.fetchImpl(
    joinUrl(
      input.baseUrl,
      `/v1/codex/tasks/${encodeURIComponent(input.taskId)}/turns/${encodeURIComponent(
        input.turnId,
      )}`,
    ),
    { headers: authHeaders(input.apiKey) },
  )
  const json = await readJson<CodexTurnGetResponse>(response, 'Codex Cloud Agent usage')
  return {
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
  }
}

async function streamTurn(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  taskId: string
  turnId: string
  signal: AbortSignal
  onChunk: (chunk: StreamChunk) => void
}): Promise<{ assistantText: string; terminalStatus: string | null }> {
  const response = await input.fetchImpl(
    joinUrl(
      input.baseUrl,
      `/v1/codex/tasks/${encodeURIComponent(input.taskId)}/turns/${encodeURIComponent(
        input.turnId,
      )}/events`,
    ),
    {
      headers: { ...authHeaders(input.apiKey), Accept: 'text/event-stream' },
      signal: input.signal,
    },
  )
  if (!response.ok) {
    const details = await response.text()
    throw new Error(
      `Codex Cloud Agent stream failed with HTTP ${String(response.status)}${details ? `: ${details}` : ''}`,
    )
  }
  if (!response.body) throw new Error('Codex Cloud Agent stream response did not include a body')

  const state = createCodexAgentStreamState()
  for await (const event of parseSseStream(response.body)) {
    for (const chunk of codexAgentEventToChunks(event, state)) input.onChunk(chunk)
    if (state.done || event.event === 'done') break
  }
  return { assistantText: state.assistantText, terminalStatus: state.terminalStatus }
}

async function buildFirstHandoffPrompt(
  prompt: PromptPayload,
  priorMessages: LLMMessage[],
): Promise<PromptPayload> {
  let branch: string | null = null
  try {
    branch = await getCurrentBranchName()
  } catch (err) {
    console.warn('[codex-agent] branch lookup failed:', err)
  }
  const preamble = buildRemoteAgentContextPreamble({ priorMessages, branch })
  if (!preamble) return prompt
  return { ...prompt, text: `${preamble}\n\n--- New message ---\n${prompt.text}` }
}

function buildLaunchNotice(reused: boolean, url?: string): string {
  const verb = reused ? 'Continuing on' : 'Running on'
  const link = url ? ` — follow along at ${url}` : ''
  return `_${verb} Codex Cloud Agent${link}_\n\n`
}

/**
 * Run a single turn on OpenAI's Codex Cloud agent. Mirrors the Cursor adapter's
 * contract (same options/result) so the dispatcher in remote-agent-client can
 * route to it transparently. Codex Cloud clones the project's GitHub repository
 * server-side, works on a branch, and (optionally) opens a PR — it does not edit
 * the local workspace.
 */
export async function runCodexAgentFromSettings(
  options: RemoteAgentRunOptions,
): Promise<RemoteAgentRunResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = resolveCodexBaseUrl()
  const apiKey = resolveOpenAiApiKey()
  const prompt = promptPayloadFromUserContent(options.userPrompt)
  if (!prompt.text.trim() && !prompt.images?.length) {
    throw new Error('Codex Cloud Agent prompt cannot be empty.')
  }

  // Capture the launching project up front: a long remote run can outlast a
  // project switch, and the link/PR must land on the project it started in.
  const launchProjectId = getActiveProjectId()

  const priorSession = readSession(options.threadId)
  const canReuse =
    priorSession?.provider === REMOTE_AGENT_PROVIDER_CODEX && priorSession.baseUrl === baseUrl

  let session: CodexAgentSession
  let turnId: string
  if (priorSession && canReuse) {
    session = priorSession
    // The remote task already holds the repo clone and prior history, so a
    // follow-up is just the new message — no context preamble needed.
    turnId = await createTurn({ fetchImpl, baseUrl, apiKey, taskId: priorSession.taskId, prompt })
  } else {
    const repository = await resolveRemoteAgentRepository()
    // Codex Cloud clones the source repo on its side, so there is no repo-less
    // mode for this provider (unlike Claude Cloud Agent).
    if (!repository) {
      throw new Error(
        'Codex Cloud Agent needs a project backed by a GitHub remote (the remote machine clones it to work). ' +
          'Open a GitHub-backed project, or switch to Claude Cloud Agent, which can run without a repository.',
      )
    }
    const startingRef = (await getCurrentBranchName())?.trim() || ''
    const created = await createTask({
      fetchImpl,
      baseUrl,
      apiKey,
      prompt: await buildFirstHandoffPrompt(prompt, options.priorMessages ?? []),
      repository,
      startingRef,
    })
    session = {
      v: 1,
      provider: REMOTE_AGENT_PROVIDER_CODEX,
      baseUrl,
      taskId: created.taskId,
      ...(created.url ? { url: created.url } : {}),
    }
    turnId = created.turnId
  }

  writeSession(options.threadId, session)

  // Record the durable agent-run ↔ thread link on a fresh task (issue #690, Q6);
  // follow-ups reuse the same task, and the PR is attached from the reply.
  if (!canReuse) {
    await recordRemoteAgentLaunch({
      projectId: launchProjectId,
      threadId: options.threadId,
      provider: REMOTE_AGENT_PROVIDER_CODEX,
      agentId: session.taskId,
      runId: turnId,
      createdAt: Date.now(),
    })
  }

  options.onChunk({
    type: 'text',
    text: buildLaunchNotice(canReuse, session.url),
  })

  const onAbort = (): void => {
    void cancelTask({ fetchImpl, baseUrl, apiKey, taskId: session.taskId }).catch(
      (err: unknown) => {
        console.warn('[codex-agent] cancel failed:', err)
      },
    )
  }
  options.signal.addEventListener('abort', onAbort, { once: true })

  try {
    const { assistantText, terminalStatus } = await streamTurn({
      fetchImpl,
      baseUrl,
      apiKey,
      taskId: session.taskId,
      turnId,
      signal: options.signal,
      onChunk: options.onChunk,
    })

    let usage = { inputTokens: 0, outputTokens: 0 }
    try {
      usage = await fetchTurnUsage({
        fetchImpl,
        baseUrl,
        apiKey,
        taskId: session.taskId,
        turnId,
      })
      if (usage.inputTokens || usage.outputTokens) {
        options.onChunk({
          type: 'usage',
          model: `${REMOTE_AGENT_MODEL_PREFIX}${REMOTE_AGENT_PROVIDER_CODEX}`,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        })
      }
    } catch (err) {
      console.warn('[codex-agent] usage fetch failed:', err)
    }

    options.onChunk(
      terminalStatus ? { type: 'done', stopReason: terminalStatus } : { type: 'done' },
    )
    // Fold the PR the agent opened (surfaced in its reply) into the link/index.
    await attachRemoteAgentPrFromText(launchProjectId, options.threadId, assistantText)
    return {
      assistantText,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      messages: assistantText ? [{ role: 'assistant', content: assistantText }] : [],
    }
  } finally {
    options.signal.removeEventListener('abort', onAbort)
  }
}
