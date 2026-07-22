/**
 * Cursor Cloud Agent HTTP/SSE adapter.
 *
 * Intentionally talks to the Cloud Agents REST API directly rather than
 * depending on `@cursor/sdk` — see docs/remote-agents.md for the trade-off.
 * Stream resume (`Last-Event-ID`, recoverable `stream_unavailable`) mirrors the
 * SDK's reconnect loop so a mid-turn SSE drop does not abort a still-running
 * remote agent.
 */
import type { LLMMessage, StreamChunk } from '@shared/types'
import {
  buildRemoteAgentContextPreamble,
  formatRemoteGitSummary,
  isRemoteAgentStreamError,
  parseSseStream,
  promptPayloadFromUserContent,
  remoteStreamEventToChunks,
  type PromptPayload,
  type RemoteStreamState,
} from '@shared/remote-agent-stream.ts'
import {
  DEFAULT_CURSOR_AGENT_BASE_URL,
  REMOTE_AGENT_MODELS,
  REMOTE_AGENT_PROVIDER_ANTHROPIC,
  REMOTE_AGENT_PROVIDER_CURSOR,
  remoteAgentModelValue,
  type RemoteAgentProvider,
} from '@shared/remote-agent.ts'
import { getApiKey, getSetting } from '../storage/settings.ts'
import { validateRemoteAgentBaseUrl } from '../security/web-origin-policy.ts'
import { getCurrentBranchName } from '../github/git-service.ts'
import { getActiveProjectId } from '../workspace.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { clearManagedAgentSession, runManagedAgentFromSettings } from './managed-agents-client.ts'
import {
  resolveRemoteAgentRepository,
  type RemoteAgentRunOptions,
  type RemoteAgentRunResult,
} from './remote-agent-shared.ts'
import { attachRemoteAgentPrFromText, recordRemoteAgentLaunch } from './remote-agent-link-store.ts'
import { LruStringCache } from './lru-string-cache.ts'

// Re-exported for callers/tests that import the repository resolver from here.
export { resolveRemoteAgentRepository } from './remote-agent-shared.ts'

const REMOTE_AGENT_SESSION_PREFIX = 'remote-agent-session:'
const REMOTE_AGENT_MODE = 'agent'
const MAX_REMOTE_ARTIFACT_IMAGE_BYTES = 15 * 1024 * 1024
// Bound the artifact-image cache so long sessions don't slowly leak memory.
// Each entry is a base64 data URL that can be ~20 MB, so we cap by total bytes
// (the memory that actually matters) with an entry-count backstop for the
// many-small-images case. 64 MB keeps a few large images or dozens of small
// ones hot while guaranteeing an upper bound.
const MAX_REMOTE_ARTIFACT_IMAGE_CACHE_ENTRIES = 64
const MAX_REMOTE_ARTIFACT_IMAGE_CACHE_BYTES = 64 * 1024 * 1024
const artifactImageDataUrlCache = new LruStringCache(
  MAX_REMOTE_ARTIFACT_IMAGE_CACHE_ENTRIES,
  MAX_REMOTE_ARTIFACT_IMAGE_CACHE_BYTES,
)

/**
 * Cursor Cloud run streams can drop mid-turn (`stream_unavailable`, network
 * blips). The Cloud Agents API documents resume via `Last-Event-ID`; we mirror
 * `@cursor/sdk`'s reconnect loop rather than depending on the SDK (see
 * docs/remote-agents.md).
 */
const MAX_STREAM_RECONNECT_ATTEMPTS = 6
const STREAM_RECONNECT_BASE_DELAY_MS = 1_000
const STREAM_RECONNECT_MAX_DELAY_MS = 30_000
const STREAM_WAIT_DEADLINE_MS = 2 * 60 * 60 * 1_000
const STREAM_POLL_INTERVAL_MS = 15_000

type StreamAttemptOutcome = 'received-result' | 'stream-dropped'

let streamReconnectDelayMsForTest: ((attempt: number) => number) | null = null

/** Test-only: force reconnect backoff (use `() => 0` for immediate retries). */
export function setRemoteStreamReconnectDelayForTest(
  delayMs: ((attempt: number) => number) | null,
): void {
  streamReconnectDelayMsForTest = delayMs
}

function streamReconnectDelayMs(attempt: number): number {
  if (streamReconnectDelayMsForTest) return streamReconnectDelayMsForTest(attempt)
  return Math.min(STREAM_RECONNECT_MAX_DELAY_MS, STREAM_RECONNECT_BASE_DELAY_MS * 2 ** attempt)
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === 'AbortError') ||
    (typeof DOMException !== 'undefined' &&
      err instanceof DOMException &&
      err.name === 'AbortError')
  )
}

interface RemoteAgentSession {
  v: 1
  provider: RemoteAgentProvider
  baseUrl: string
  agentId: string
  /**
   * Upstream model id used when this agent was created. Absent on sessions
   * persisted before multi-model support (treated as account default). Cursor
   * cannot change model on follow-up runs, so a different selection must start
   * a new agent.
   */
  model?: string
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
  /** When set, passed as `model.id` on Create Agent; omit for account default. */
  model?: string
}): Promise<{ agentId: string; runId: string; url?: string }> {
  const repository = await resolveRemoteAgentRepository()
  // Cursor's agent API clones the source repo on its side, so there is no
  // repo-less mode for this provider (unlike Claude Cloud Agent).
  if (!repository) {
    throw new Error(
      'Cursor Cloud Agent needs a project backed by a GitHub remote (the remote machine clones it to work). ' +
        'Open a GitHub-backed project, or switch to Claude Cloud Agent, which can run without a repository.',
    )
  }
  // Branch the remote run from whatever branch this project is on locally. The
  // remote clones from GitHub, so a branch that hasn't been pushed falls back to
  // the repo's default ref (startingRef omitted).
  const startingRef = (await getCurrentBranchName())?.trim() || ''
  const modelId = input.model?.trim()
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
    ...(modelId ? { model: { id: modelId } } : {}),
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

interface CursorRunResponse {
  id?: string
  status?: string
  result?: string
  git?: {
    branches?: Array<{ repoUrl?: string; branch?: string; prUrl?: string }>
  }
}

function isTerminalRunStatus(status: string | null | undefined): boolean {
  return (
    status === 'FINISHED' || status === 'ERROR' || status === 'CANCELLED' || status === 'EXPIRED'
  )
}

async function fetchCursorRun(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  agentId: string
  runId: string
  signal: AbortSignal
}): Promise<CursorRunResponse> {
  const response = await input.fetchImpl(
    joinUrl(
      input.baseUrl,
      `/v1/agents/${encodeURIComponent(input.agentId)}/runs/${encodeURIComponent(input.runId)}`,
    ),
    {
      headers: { Authorization: cursorAuthHeader(input.apiKey) },
      signal: input.signal,
    },
  )
  return readJsonResponse<CursorRunResponse>(response, 'Remote agent get run')
}

function applyCursorRunSnapshot(
  run: CursorRunResponse,
  state: RemoteStreamState,
  onChunk: (chunk: StreamChunk) => void,
): void {
  if (run.status) state.terminalStatus = run.status
  if (typeof run.result === 'string') {
    state.resultText = run.result
    if (!state.assistantText && run.result) {
      state.assistantText = run.result
      onChunk({ type: 'text', text: run.result })
    }
  }
  const gitSummary = formatRemoteGitSummary(run.git)
  if (gitSummary) onChunk({ type: 'text', text: gitSummary })
}

/**
 * One SSE attempt. Returns `received-result` when the run terminal `result`
 * (or `done` after a terminal status) arrived; `stream-dropped` when the body
 * ended without a terminal event so the caller should resume.
 */
async function streamRemoteRunAttempt(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  agentId: string
  runId: string
  lastEventId: string | undefined
  signal: AbortSignal
  state: RemoteStreamState
  seenEventIds: Set<string>
  onChunk: (chunk: StreamChunk) => void
  onEventId: (id: string) => void
}): Promise<StreamAttemptOutcome> {
  const headers: Record<string, string> = {
    Authorization: cursorAuthHeader(input.apiKey),
    Accept: 'text/event-stream',
  }
  if (input.lastEventId) headers['Last-Event-ID'] = input.lastEventId

  const response = await input.fetchImpl(
    joinUrl(
      input.baseUrl,
      `/v1/agents/${encodeURIComponent(input.agentId)}/runs/${encodeURIComponent(
        input.runId,
      )}/stream`,
    ),
    {
      headers,
      signal: input.signal,
    },
  )

  if (response.status === 410) {
    // Retention elapsed — fall back to Get A Run instead of retrying the stream.
    const run = await fetchCursorRun(input)
    if (isTerminalRunStatus(run.status)) {
      applyCursorRunSnapshot(run, input.state, input.onChunk)
      return 'received-result'
    }
    throw new Error(
      `Remote agent stream expired (HTTP 410) while run status is ${run.status ?? 'unknown'}`,
    )
  }

  if (!response.ok) {
    const details = await response.text()
    // Stale resume cursor — clear and let the outer loop retry from the head.
    if (response.status === 400 && /invalid_last_event_id/i.test(details)) {
      throw new RemoteAgentInvalidLastEventIdError(details)
    }
    throw new Error(
      `Remote agent stream failed with HTTP ${String(response.status)}${details ? `: ${details}` : ''}`,
    )
  }
  if (!response.body) throw new Error('Remote agent stream response did not include a body')

  let sawTerminal = false
  for await (const event of parseSseStream(response.body)) {
    if (input.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (event.id) {
      input.onEventId(event.id)
      // Reconnect without Last-Event-ID can replay retained events; skip dupes.
      if (input.seenEventIds.has(event.id)) continue
      input.seenEventIds.add(event.id)
    }
    for (const chunk of remoteStreamEventToChunks(event, input.state)) input.onChunk(chunk)
    if (event.event === 'result' || isTerminalRunStatus(input.state.terminalStatus)) {
      sawTerminal = true
    }
    if (event.event === 'done') return sawTerminal ? 'received-result' : 'stream-dropped'
  }

  return sawTerminal || isTerminalRunStatus(input.state.terminalStatus)
    ? 'received-result'
    : 'stream-dropped'
}

class RemoteAgentInvalidLastEventIdError extends Error {
  constructor(details: string) {
    super(details || 'invalid_last_event_id')
    this.name = 'RemoteAgentInvalidLastEventIdError'
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
  const state: RemoteStreamState = {
    seenToolCalls: new Set(),
    assistantText: '',
    resultText: '',
    terminalStatus: null,
  }
  const seenEventIds = new Set<string>()
  let lastEventId: string | undefined
  let attempt = 0
  const deadline = Date.now() + STREAM_WAIT_DEADLINE_MS

  while (!input.signal.aborted) {
    const resumeFrom = lastEventId
    try {
      const outcome = await streamRemoteRunAttempt({
        fetchImpl: input.fetchImpl,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        agentId: input.agentId,
        runId: input.runId,
        lastEventId,
        signal: input.signal,
        state,
        seenEventIds,
        onChunk: input.onChunk,
        onEventId: (id) => {
          lastEventId = id
        },
      })
      if (outcome === 'received-result') return state
    } catch (err) {
      if (isAbortError(err)) throw err
      if (err instanceof RemoteAgentInvalidLastEventIdError) {
        // Only clear if nothing newer arrived during the failed attempt.
        if (lastEventId === resumeFrom) lastEventId = undefined
      } else if (isRemoteAgentStreamError(err)) {
        if (err.fatal) throw err
        // Recoverable SSE error (e.g. stream_unavailable) — reconnect below.
        console.warn('[remote-agent] stream dropped, reconnecting:', err.message)
      } else {
        // Network / transient HTTP failures — reconnect if the run is still live.
        console.warn('[remote-agent] stream attempt failed, reconnecting:', err)
      }
    }

    // Prefer Get A Run when the stream is gone but the run may already be terminal.
    try {
      const run = await fetchCursorRun({
        fetchImpl: input.fetchImpl,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        agentId: input.agentId,
        runId: input.runId,
        signal: input.signal,
      })
      if (isTerminalRunStatus(run.status)) {
        applyCursorRunSnapshot(run, state, input.onChunk)
        return state
      }
    } catch (err) {
      if (isAbortError(err)) throw err
      console.warn('[remote-agent] get run during reconnect failed:', err)
    }

    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the remote agent run to finish.')
    }

    if (attempt >= MAX_STREAM_RECONNECT_ATTEMPTS) {
      // SDK falls back to polling Get A Run after the reconnect budget.
      while (Date.now() < deadline) {
        await sleep(
          Math.min(STREAM_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
          input.signal,
        )
        const run = await fetchCursorRun({
          fetchImpl: input.fetchImpl,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          agentId: input.agentId,
          runId: input.runId,
          signal: input.signal,
        })
        if (isTerminalRunStatus(run.status)) {
          applyCursorRunSnapshot(run, state, input.onChunk)
          return state
        }
      }
      throw new Error('Timed out waiting for the remote agent run to finish.')
    }

    const delay = Math.min(streamReconnectDelayMs(attempt), Math.max(0, deadline - Date.now()))
    attempt += 1
    await sleep(delay, input.signal)
  }

  throw new DOMException('Aborted', 'AbortError')
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

  // Capture the launching project up front: a long remote run can outlast a
  // project switch, and the link/PR must land on the project it started in.
  const launchProjectId = getActiveProjectId()

  const selectedModel = options.model?.trim() || undefined
  const priorSession = readSession(options.threadId)
  // Cursor binds the model at agent create; a different selection (or switching
  // back to account default) must start a fresh agent rather than follow-up.
  const canReuseSession =
    priorSession?.provider === options.provider &&
    priorSession.baseUrl === baseUrl &&
    (priorSession.model ?? undefined) === selectedModel

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
        ...(selectedModel ? { model: selectedModel } : {}),
      })

  writeSession(options.threadId, {
    v: 1,
    provider: options.provider,
    baseUrl,
    agentId: run.agentId,
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(run.url ? { url: run.url } : {}),
  })

  // Record the durable agent-run ↔ thread link at launch (issue #690, Q6). Only
  // on a fresh agent — a follow-up reuses the same agent/link, and the PR it
  // opens is attached from the reply below.
  if (!canReuseSession) {
    await recordRemoteAgentLaunch({
      projectId: launchProjectId,
      threadId: options.threadId,
      provider: options.provider,
      agentId: run.agentId,
      runId: run.runId,
      createdAt: Date.now(),
    })
  }

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
          model: remoteAgentModelValue(options.provider, selectedModel),
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
    // Once the reply reveals the PR the agent opened, fold it into the link/index.
    await attachRemoteAgentPrFromText(launchProjectId, options.threadId, assistantText)
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
