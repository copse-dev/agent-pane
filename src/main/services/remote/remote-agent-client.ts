import type { LLMMessage, StreamChunk } from '@shared/types'
import {
  buildRemoteAgentContextPreamble,
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
  REMOTE_AGENT_PROVIDER_ANTHROPIC,
  REMOTE_AGENT_PROVIDER_CURSOR,
  type RemoteAgentProvider,
} from '@shared/remote-agent.ts'
import { getApiKey, getSetting } from '../settings.ts'
import { validateRemoteAgentBaseUrl } from '../security/web-origin-policy.ts'
import { getCurrentBranchName } from '../github/git-service.ts'
import { storageGet, storageSet } from '../storage.ts'
import { clearManagedAgentSession, runManagedAgentFromSettings } from './managed-agents-client.ts'
import {
  resolveRemoteAgentRepository,
  type RemoteAgentRunOptions,
  type RemoteAgentRunResult,
} from './remote-agent-shared.ts'

// Re-exported for callers/tests that import the repository resolver from here.
export { resolveRemoteAgentRepository } from './remote-agent-shared.ts'

const REMOTE_AGENT_SESSION_PREFIX = 'remote-agent-session:'
const REMOTE_AGENT_MODE = 'agent'
const MAX_REMOTE_ARTIFACT_IMAGE_BYTES = 15 * 1024 * 1024
const artifactImageDataUrlCache = new Map<string, string>()

interface RemoteAgentSession {
  v: 1
  provider: RemoteAgentProvider
  baseUrl: string
  agentId: string
  /** Web URL for the remote run (e.g. cursor.com/agents/...), shown in the transcript. */
  url?: string
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

export interface RemoteAgentArtifact {
  path: string
  sizeBytes?: number
  updatedAt?: string
}

interface CursorArtifactsResponse {
  items?: Array<{
    path?: string
    sizeBytes?: number
    updatedAt?: string
  }>
}

interface CursorArtifactDownloadResponse {
  url?: string
  expiresAt?: string
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
  // Clear the Claude Managed Agents session for this thread too, so a fresh chat
  // starts a new remote session regardless of which provider was last used.
  clearManagedAgentSession(threadId)
}

function cursorAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

function remoteArtifactDownloadEndpoint(baseUrl: string, agentId: string, path: string): string {
  const params = new URLSearchParams({ path })
  return joinUrl(baseUrl, `/v1/agents/${encodeURIComponent(agentId)}/artifacts/download?${params}`)
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
    throw new Error(`${label} failed with HTTP ${String(response.status)}${details}`)
  }
  try {
    return (text ? JSON.parse(text) : {}) as T
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

/**
 * Defensively re-validate the renderer-writable base URL before it is used to
 * send the API key. A tampered or synced setting could otherwise point the
 * Authorization header at an attacker-controlled (or cleartext) host. Invalid
 * Cursor base URLs fall back to the safe default; other providers must fix the
 * setting because they have no safe default.
 */
function readValidatedBaseUrl(provider: RemoteAgentProvider): string {
  const raw = getSetting<string>('remoteAgentBaseUrl', '').trim()
  // Provider dispatch: scope the safe-default fallback to Cursor so other providers
  // added later must fix the setting rather than inherit Cursor's default.
  if (provider === REMOTE_AGENT_PROVIDER_CURSOR) {
    if (!raw) return DEFAULT_CURSOR_AGENT_BASE_URL
    try {
      validateRemoteAgentBaseUrl(raw)
      return raw
    } catch (err) {
      console.warn('[remote-agent] ignoring invalid remoteAgentBaseUrl, using default:', err)
      return DEFAULT_CURSOR_AGENT_BASE_URL
    }
  }
  if (!raw) {
    throw new Error('Configure Settings → Remote agents → Agent API base URL before using Copse.')
  }
  validateRemoteAgentBaseUrl(raw)
  return raw
}

function resolveBaseUrl(provider: RemoteAgentProvider): string {
  return readValidatedBaseUrl(provider)
}

function resolveApiKey(): string {
  const apiKey = getApiKey('cursor') ?? process.env['CURSOR_API_KEY'] ?? null
  if (!apiKey) {
    throw new Error('Configure a Cursor API key in Settings before using remote agents.')
  }
  return apiKey
}

function assertArtifactPath(path: string): string {
  if (!path.startsWith('artifacts/') || path.includes('\0') || path.includes('..')) {
    throw new Error('Artifact path must be a relative artifacts/ path.')
  }
  return path
}

function artifactCacheKey(agentId: string, path: string): string {
  return `${agentId}\0${path}`
}

async function createRemoteAgent(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  prompt: PromptPayload
}): Promise<{ agentId: string; runId: string; url?: string }> {
  const repository = await resolveRemoteAgentRepository()
  // Branch the remote run from whatever branch this project is on locally. The
  // remote clones from GitHub, so a branch that hasn't been pushed falls back to
  // the repo's default ref (startingRef omitted).
  const startingRef = (await getCurrentBranchName())?.trim() || ''
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

/**
 * The remote machine starts with no memory of the local chat that preceded it.
 * On the first hand-off (new agent), prepend the prior conversation and the
 * current branch so the remote agent continues rather than starting cold.
 * Follow-up runs reuse the same remote agent, which already has the history.
 */
async function buildFirstHandoffPrompt(
  prompt: PromptPayload,
  priorMessages: LLMMessage[],
): Promise<PromptPayload> {
  let branch: string | null = null
  try {
    branch = await getCurrentBranchName()
  } catch (err) {
    console.warn('[remote-agent] branch lookup failed:', err)
  }
  const preamble = buildRemoteAgentContextPreamble({ priorMessages, branch })
  if (!preamble) return prompt
  return { ...prompt, text: `${preamble}\n\n--- New message ---\n${prompt.text}` }
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
      `Remote agent cancel failed with HTTP ${String(response.status)}${details ? `: ${details}` : ''}`,
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

export async function listRemoteArtifacts(input: {
  fetchImpl?: typeof fetch
  baseUrl: string
  apiKey: string
  agentId: string
}): Promise<RemoteAgentArtifact[]> {
  const fetchImpl = input.fetchImpl ?? fetch
  const response = await fetchImpl(
    joinUrl(input.baseUrl, `/v1/agents/${encodeURIComponent(input.agentId)}/artifacts`),
    {
      headers: { Authorization: cursorAuthHeader(input.apiKey) },
    },
  )
  const json = await readJsonResponse<CursorArtifactsResponse>(response, 'Remote agent artifacts')
  return (json.items ?? [])
    .filter((item): item is RemoteAgentArtifact => typeof item.path === 'string')
    .map((item) => ({
      path: item.path,
      ...(typeof item.sizeBytes === 'number' ? { sizeBytes: item.sizeBytes } : {}),
      ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
    }))
}

export async function resolveRemoteArtifactDownloadUrl(input: {
  fetchImpl?: typeof fetch
  baseUrl?: string
  apiKey?: string
  agentId: string
  path: string
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch
  const baseUrl = input.baseUrl ?? readValidatedBaseUrl(REMOTE_AGENT_PROVIDER_CURSOR)
  const apiKey = input.apiKey ?? resolveApiKey()
  const path = assertArtifactPath(input.path)
  const response = await fetchImpl(remoteArtifactDownloadEndpoint(baseUrl, input.agentId, path), {
    headers: { Authorization: cursorAuthHeader(apiKey) },
  })
  const json = await readJsonResponse<CursorArtifactDownloadResponse>(
    response,
    'Remote agent artifact download',
  )
  if (!json.url) throw new Error('Remote agent artifact download response did not include a URL')
  return json.url
}

function imageMimeTypeForPath(path: string): string | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  return null
}

export async function fetchRemoteArtifactImageDataUrl(input: {
  fetchImpl?: typeof fetch
  baseUrl?: string
  apiKey?: string
  agentId: string
  path: string
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch
  const path = assertArtifactPath(input.path)
  const cacheKey = artifactCacheKey(input.agentId, path)
  const cached = artifactImageDataUrlCache.get(cacheKey)
  if (cached) return cached

  const url = await resolveRemoteArtifactDownloadUrl({ ...input, path, fetchImpl })
  const response = await fetchImpl(url)
  if (!response.ok) {
    const details = await response.text()
    throw new Error(
      `Remote agent artifact image fetch failed with HTTP ${String(response.status)}${details ? `: ${details}` : ''}`,
    )
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_REMOTE_ARTIFACT_IMAGE_BYTES) {
    throw new Error(`Remote agent artifact image is too large (${String(contentLength)} bytes).`)
  }
  const mimeType =
    response.headers.get('content-type')?.split(';')[0]?.trim() || imageMimeTypeForPath(path)
  if (!mimeType?.startsWith('image/')) {
    throw new Error('Remote agent artifact is not an image.')
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > MAX_REMOTE_ARTIFACT_IMAGE_BYTES) {
    throw new Error(
      `Remote agent artifact image is too large (${String(buffer.byteLength)} bytes).`,
    )
  }
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
  artifactImageDataUrlCache.set(cacheKey, dataUrl)
  return dataUrl
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, '\\`')
}

export function formatRemoteArtifactsSummary(input: {
  artifacts: RemoteAgentArtifact[]
  baseUrl: string
  agentId: string
}): string {
  if (input.artifacts.length === 0) return ''
  const lines = input.artifacts.map((artifact) => {
    const size = formatBytes(artifact.sizeBytes)
    const meta = size ? ` (${size})` : ''
    const url = remoteArtifactDownloadEndpoint(input.baseUrl, input.agentId, artifact.path)
    return `- \`${escapeInlineCode(artifact.path)}\`${meta} — [Open](${url})`
  })
  return `\n\n---\n_Remote agent artifacts:_\n${lines.join('\n')}`
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
      `Remote agent stream failed with HTTP ${String(response.status)}${details ? `: ${details}` : ''}`,
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
  // Each remote provider has its own API shape; route to the matching adapter.
  if (options.provider === REMOTE_AGENT_PROVIDER_ANTHROPIC) {
    return runManagedAgentFromSettings(options)
  }

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
    : await createRemoteAgent({
        fetchImpl,
        baseUrl,
        apiKey,
        prompt: await buildFirstHandoffPrompt(prompt, options.priorMessages ?? []),
      })

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

  const abortCancel = (): void => {
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
    try {
      const artifacts = await listRemoteArtifacts({
        fetchImpl,
        baseUrl,
        apiKey,
        agentId: run.agentId,
      })
      const summary = formatRemoteArtifactsSummary({ artifacts, baseUrl, agentId: run.agentId })
      if (summary) options.onChunk({ type: 'text', text: summary })
    } catch (err) {
      console.warn('[remote-agent] artifacts fetch failed:', err)
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
