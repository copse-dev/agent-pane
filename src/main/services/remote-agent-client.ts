import type { StreamChunk, UserContent } from '@shared/types'
import {
  parseSseStream,
  promptPayloadFromUserContent,
  remoteStreamEventToChunks,
  type PromptPayload,
  type RemoteStreamState,
} from '@shared/remote-agent-stream.ts'
import {
  DEFAULT_CURSOR_AGENT_BASE_URL,
  REMOTE_AGENT_MODELS,
  REMOTE_AGENT_MODEL_PREFIX,
  REMOTE_AGENT_PROVIDER_CURSOR,
  type RemoteAgentProvider,
} from '@shared/remote-agent.ts'
import { getApiKey, getSetting } from './settings.ts'
import { getGithubRepoSlug } from './git-service.ts'
import { storageGet, storageSet } from './storage.ts'

const REMOTE_AGENT_SESSION_PREFIX = 'remote-agent-session:'
const REMOTE_AGENT_MODE = 'agent'

interface RemoteAgentSession {
  v: 1
  provider: RemoteAgentProvider
  baseUrl: string
  agentId: string
  /** Web URL for the remote run (e.g. cursor.com/agents/...), shown in the transcript. */
  url?: string
}

interface RemoteAgentRunResult {
  assistantText: string
  inputTokens: number
  outputTokens: number
  messages: Array<{ role: 'assistant'; content: string }>
}

interface RemoteAgentRunOptions {
  threadId: string
  provider: RemoteAgentProvider
  userPrompt: UserContent
  signal: AbortSignal
  onChunk: (chunk: StreamChunk) => void
  fetchImpl?: typeof fetch
}

interface CursorCreateAgentResponse {
  agent?: { id?: string; url?: string }
  run?: { id?: string; agentId?: string }
}

interface CursorCreateRunResponse {
  run?: { id?: string; agentId?: string }
}

interface CursorUsageResponse {
  runs?: Array<{
    id?: string
    usage?: {
      inputTokens?: number
      outputTokens?: number
    }
  }>
}

function sessionKey(threadId: string): string {
  return `${REMOTE_AGENT_SESSION_PREFIX}${threadId}`
}

function readSession(threadId: string): RemoteAgentSession | null {
  const raw = storageGet(sessionKey(threadId))
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<RemoteAgentSession>
  if (
    value.v !== 1 ||
    !value.agentId ||
    !value.provider ||
    !value.baseUrl ||
    typeof value.agentId !== 'string' ||
    typeof value.baseUrl !== 'string'
  ) {
    return null
  }
  return value as RemoteAgentSession
}

function writeSession(threadId: string, session: RemoteAgentSession): void {
  storageSet(sessionKey(threadId), session)
}

export function clearRemoteAgentSession(threadId: string): void {
  storageSet(sessionKey(threadId), null)
}

function cursorAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

function assertRunId(response: CursorCreateAgentResponse | CursorCreateRunResponse): string {
  const runId = response.run?.id
  if (!runId) throw new Error('Remote agent response did not include a run id')
  return runId
}

function assertAgentId(response: CursorCreateAgentResponse): string {
  const agentId = response.agent?.id ?? response.run?.agentId
  if (!agentId) throw new Error('Remote agent response did not include an agent id')
  return agentId
}

async function readJsonResponse<T>(response: Response, label: string): Promise<T> {
  const text = await response.text()
  if (!response.ok) {
    const details = text ? `: ${text}` : ''
    throw new Error(`${label} failed with HTTP ${response.status}${details}`)
  }
  try {
    return (text ? JSON.parse(text) : {}) as T
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

function resolveBaseUrl(provider: RemoteAgentProvider): string {
  if (provider === REMOTE_AGENT_PROVIDER_CURSOR) {
    return getSetting<string>('remoteAgentBaseUrl', DEFAULT_CURSOR_AGENT_BASE_URL).trim()
  }
  const baseUrl = getSetting<string>('remoteAgentBaseUrl', '').trim()
  if (!baseUrl) {
    throw new Error('Configure Settings → Remote agents → Agent API base URL before using Copse.')
  }
  return baseUrl
}

function resolveApiKey(): string {
  const apiKey = getApiKey('cursor') ?? process.env.CURSOR_API_KEY ?? null
  if (!apiKey) {
    throw new Error('Configure a Cursor API key in Settings before using remote agents.')
  }
  return apiKey
}

function normalizeRepository(raw: string): string {
  const value = raw.trim()
  if (!value) return value
  if (/^https?:\/\//i.test(value)) return value
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return `https://github.com/${value}`
  return value
}

async function resolveRepository(): Promise<string> {
  const configured = normalizeRepository(getSetting<string>('remoteAgentRepository', ''))
  if (configured) return configured
  const slug = await getGithubRepoSlug()
  if (slug) return `https://github.com/${slug}`
  throw new Error(
    'Could not infer a GitHub repository from the workspace. Configure Settings → Remote agents → Repository.',
  )
}

async function createRemoteAgent(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  prompt: PromptPayload
}): Promise<{ agentId: string; runId: string; url?: string }> {
  const repository = await resolveRepository()
  const startingRef = getSetting<string>('remoteAgentStartingRef', '').trim()
  const body = {
    prompt: input.prompt,
    repos: [
      {
        url: repository,
        ...(startingRef ? { startingRef } : {}),
      },
    ],
    mode: REMOTE_AGENT_MODE,
    workOnCurrentBranch: getSetting<boolean>('remoteAgentWorkOnCurrentBranch', false),
    autoCreatePR: getSetting<boolean>('remoteAgentAutoCreatePR', true),
  }

  const response = await input.fetchImpl(joinUrl(input.baseUrl, '/v1/agents'), {
    method: 'POST',
    headers: {
      Authorization: cursorAuthHeader(input.apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const json = await readJsonResponse<CursorCreateAgentResponse>(response, 'Remote agent create')
  return {
    agentId: assertAgentId(json),
    runId: assertRunId(json),
    ...(json.agent?.url ? { url: json.agent.url } : {}),
  }
}

function remoteAgentLabel(provider: RemoteAgentProvider): string {
  return REMOTE_AGENT_MODELS.find((option) => option.provider === provider)?.label ?? 'remote agent'
}

/**
 * Opening status line so users can see the turn was handed off to the remote
 * machine (and follow along in the web UI) instead of running locally.
 */
function buildLaunchNotice(input: {
  provider: RemoteAgentProvider
  reused: boolean
  url?: string
}): string {
  const label = remoteAgentLabel(input.provider)
  const verb = input.reused ? 'Continuing on' : 'Running on'
  const link = input.url ? ` — follow along at ${input.url}` : ''
  return `_${verb} ${label}${link}_\n\n`
}

async function createRemoteRun(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  agentId: string
  prompt: PromptPayload
}): Promise<string> {
  const response = await input.fetchImpl(
    joinUrl(input.baseUrl, `/v1/agents/${encodeURIComponent(input.agentId)}/runs`),
    {
      method: 'POST',
      headers: {
        Authorization: cursorAuthHeader(input.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt: input.prompt, mode: REMOTE_AGENT_MODE }),
    },
  )
  const json = await readJsonResponse<CursorCreateRunResponse>(response, 'Remote agent follow-up')
  return assertRunId(json)
}

async function cancelRemoteRun(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  agentId: string
  runId: string
}): Promise<void> {
  const response = await input.fetchImpl(
    joinUrl(
      input.baseUrl,
      `/v1/agents/${encodeURIComponent(input.agentId)}/runs/${encodeURIComponent(
        input.runId,
      )}/cancel`,
    ),
    {
      method: 'POST',
      headers: { Authorization: cursorAuthHeader(input.apiKey) },
    },
  )
  if (!response.ok && response.status !== 409) {
    const details = await response.text()
    throw new Error(
      `Remote agent cancel failed with HTTP ${response.status}${details ? `: ${details}` : ''}`,
    )
  }
}

async function fetchRunUsage(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  agentId: string
  runId: string
}): Promise<{ inputTokens: number; outputTokens: number }> {
  const params = new URLSearchParams({ runId: input.runId })
  const response = await input.fetchImpl(
    joinUrl(input.baseUrl, `/v1/agents/${encodeURIComponent(input.agentId)}/usage?${params}`),
    {
      headers: { Authorization: cursorAuthHeader(input.apiKey) },
    },
  )
  const json = await readJsonResponse<CursorUsageResponse>(response, 'Remote agent usage')
  const usage = json.runs?.find((run) => run.id === input.runId)?.usage
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  }
}

async function streamRemoteRun(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  agentId: string
  runId: string
  signal: AbortSignal
  onChunk: (chunk: StreamChunk) => void
}): Promise<RemoteStreamState> {
  const response = await input.fetchImpl(
    joinUrl(
      input.baseUrl,
      `/v1/agents/${encodeURIComponent(input.agentId)}/runs/${encodeURIComponent(
        input.runId,
      )}/stream`,
    ),
    {
      headers: {
        Authorization: cursorAuthHeader(input.apiKey),
        Accept: 'text/event-stream',
      },
      signal: input.signal,
    },
  )

  if (!response.ok) {
    const details = await response.text()
    throw new Error(
      `Remote agent stream failed with HTTP ${response.status}${details ? `: ${details}` : ''}`,
    )
  }
  if (!response.body) throw new Error('Remote agent stream response did not include a body')

  const state: RemoteStreamState = {
    seenToolCalls: new Set(),
    assistantText: '',
    resultText: '',
    terminalStatus: null,
  }

  for await (const event of parseSseStream(response.body)) {
    for (const chunk of remoteStreamEventToChunks(event, state)) input.onChunk(chunk)
    if (event.event === 'done') break
  }

  return state
}

export async function runRemoteAgentFromSettings(
  options: RemoteAgentRunOptions,
): Promise<RemoteAgentRunResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = resolveBaseUrl(options.provider)
  const apiKey = resolveApiKey()
  const prompt = promptPayloadFromUserContent(options.userPrompt)
  if (!prompt.text.trim() && !prompt.images?.length) {
    throw new Error('Remote agent prompt cannot be empty.')
  }

  const priorSession = readSession(options.threadId)
  const canReuseSession =
    priorSession?.provider === options.provider && priorSession.baseUrl === baseUrl

  const run: { agentId: string; runId: string; url?: string } = canReuseSession
    ? {
        agentId: priorSession.agentId,
        runId: await createRemoteRun({
          fetchImpl,
          baseUrl,
          apiKey,
          agentId: priorSession.agentId,
          prompt,
        }),
        ...(priorSession.url ? { url: priorSession.url } : {}),
      }
    : await createRemoteAgent({ fetchImpl, baseUrl, apiKey, prompt })

  writeSession(options.threadId, {
    v: 1,
    provider: options.provider,
    baseUrl,
    agentId: run.agentId,
    ...(run.url ? { url: run.url } : {}),
  })

  // Make the remote hand-off explicit in the transcript (parity with how a local
  // chat shows its activity inline).
  options.onChunk({
    type: 'text',
    text: buildLaunchNotice({
      provider: options.provider,
      reused: canReuseSession,
      ...(run.url ? { url: run.url } : {}),
    }),
  })

  const abortCancel = () => {
    void cancelRemoteRun({
      fetchImpl,
      baseUrl,
      apiKey,
      agentId: run.agentId,
      runId: run.runId,
    }).catch((err: unknown) => {
      console.warn('[remote-agent] cancel failed:', err)
    })
  }
  options.signal.addEventListener('abort', abortCancel, { once: true })

  try {
    const state = await streamRemoteRun({
      fetchImpl,
      baseUrl,
      apiKey,
      agentId: run.agentId,
      runId: run.runId,
      signal: options.signal,
      onChunk: options.onChunk,
    })
    let usage = { inputTokens: 0, outputTokens: 0 }
    try {
      usage = await fetchRunUsage({
        fetchImpl,
        baseUrl,
        apiKey,
        agentId: run.agentId,
        runId: run.runId,
      })
      if (usage.inputTokens || usage.outputTokens) {
        options.onChunk({
          type: 'usage',
          model: `${REMOTE_AGENT_MODEL_PREFIX}${options.provider}`,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        })
      }
    } catch (err) {
      console.warn('[remote-agent] usage fetch failed:', err)
    }
    options.onChunk(
      state.terminalStatus ? { type: 'done', stopReason: state.terminalStatus } : { type: 'done' },
    )
    const assistantText = state.assistantText || state.resultText
    return {
      assistantText,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      messages: assistantText ? [{ role: 'assistant', content: assistantText }] : [],
    }
  } finally {
    options.signal.removeEventListener('abort', abortCancel)
  }
}
