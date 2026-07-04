import type { LLMMessage, StreamChunk } from '@shared/types'
import {
  buildRemoteAgentContextPreamble,
  parseSseStream,
  promptPayloadFromUserContent,
  type PromptPayload,
} from '@shared/remote-agent-stream.ts'
import {
  createManagedAgentStreamState,
  managedAgentEventToChunks,
} from '@shared/managed-agents-stream.ts'
import {
  buildManagedAgentSystemPrompt,
  DEFAULT_MANAGED_AGENT_BRANCH_PREFIX,
  DEFAULT_MANAGED_AGENT_MODEL,
  GITHUB_MCP_SERVER_NAME,
  GITHUB_MCP_SERVER_URL,
  MANAGED_AGENT_REPO_MOUNT_PATH,
} from '@shared/managed-agents.ts'
import {
  DEFAULT_ANTHROPIC_AGENT_BASE_URL,
  DEFAULT_CURSOR_AGENT_BASE_URL,
  REMOTE_AGENT_MODEL_PREFIX,
  REMOTE_AGENT_PROVIDER_ANTHROPIC,
} from '@shared/remote-agent.ts'
import { getSetting, resolveApiKey } from './settings.ts'
import { validateRemoteAgentBaseUrl } from './web-origin-policy.ts'
import { getCurrentBranchName } from './github/git-service.ts'
import { storageGet, storageSet } from './storage.ts'
import {
  parseGithubOwnerRepo,
  resolveRemoteAgentRepository,
  type RemoteAgentRunOptions,
  type RemoteAgentRunResult,
} from './remote-agent-shared.ts'

const MANAGED_AGENT_SESSION_PREFIX = 'managed-agent-session:'
const ANTHROPIC_VERSION = '2023-06-01'
const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01'
const AGENT_TOOLSET_TYPE = 'agent_toolset_20260401'

interface ManagedAgentSession {
  v: 1
  provider: typeof REMOTE_AGENT_PROVIDER_ANTHROPIC
  baseUrl: string
  sessionId: string
  agentId: string
  environmentId: string
  /** Last cumulative usage seen for this session, so follow-ups report a delta. */
  usageInput: number
  usageOutput: number
}

interface AgentCreateResponse {
  id?: string
}
interface EnvironmentCreateResponse {
  id?: string
}
interface SessionCreateResponse {
  id?: string
}
interface SessionGetResponse {
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

function sessionKey(threadId: string): string {
  return `${MANAGED_AGENT_SESSION_PREFIX}${threadId}`
}

function readSession(threadId: string): ManagedAgentSession | null {
  const raw = storageGet(sessionKey(threadId))
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<ManagedAgentSession>
  if (
    value.v !== 1 ||
    typeof value.sessionId !== 'string' ||
    typeof value.baseUrl !== 'string' ||
    value.provider !== REMOTE_AGENT_PROVIDER_ANTHROPIC
  ) {
    return null
  }
  return value as ManagedAgentSession
}

function writeSession(threadId: string, session: ManagedAgentSession): void {
  storageSet(sessionKey(threadId), session)
}

export function clearManagedAgentSession(threadId: string): void {
  storageSet(sessionKey(threadId), null)
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': MANAGED_AGENTS_BETA,
    'content-type': 'application/json',
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

/**
 * Resolve the Anthropic Managed Agents base URL. The base-URL setting is shared
 * with Cursor and defaults to Cursor's host, so an empty value or the literal
 * Cursor default both mean "use Anthropic's default" here; only a deliberately
 * different custom value (e.g. for API testing) is honored, after revalidation.
 */
function resolveManagedBaseUrl(): string {
  const raw = getSetting<string>('remoteAgentBaseUrl', '').trim()
  if (!raw || raw === DEFAULT_CURSOR_AGENT_BASE_URL) return DEFAULT_ANTHROPIC_AGENT_BASE_URL
  validateRemoteAgentBaseUrl(raw)
  return raw
}

function resolveAnthropicApiKey(): string {
  const key = resolveApiKey(REMOTE_AGENT_PROVIDER_ANTHROPIC)
  if (!key) {
    throw new Error('Configure an Anthropic API key in Settings before using Claude Agent.')
  }
  return key
}

function resolveGithubToken(): string {
  const token = resolveApiKey('github')
  if (!token) {
    throw new Error(
      'Configure a GitHub token in Settings → Remote agents before using Claude Agent. ' +
        'It is used only to clone and push the repository (repo scope).',
    )
  }
  return token
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

async function createAgent(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  system: string
}): Promise<string> {
  const body = {
    name: 'Copse Claude Agent',
    model: DEFAULT_MANAGED_AGENT_MODEL,
    system: input.system,
    // TODO(api-verify): The GitHub MCP server is registered with no auth here, yet
    // the system prompt instructs the agent to push branches / open PRs via these
    // MCP tools. This only works if the platform injects the `github_repository`
    // session resource's `authorization_token` (see createSession) into the MCP
    // server automatically. If it does NOT, the MCP server needs its own auth
    // (e.g. an Authorization header) and PR creation will fail silently. Confirm
    // against the Managed Agents API before relying on auto PR creation.
    mcp_servers: [{ type: 'url', name: GITHUB_MCP_SERVER_NAME, url: GITHUB_MCP_SERVER_URL }],
    tools: [
      { type: AGENT_TOOLSET_TYPE },
      { type: 'mcp_toolset', mcp_server_name: GITHUB_MCP_SERVER_NAME },
    ],
  }
  const response = await input.fetchImpl(joinUrl(input.baseUrl, '/v1/agents'), {
    method: 'POST',
    headers: authHeaders(input.apiKey),
    body: JSON.stringify(body),
  })
  const json = await readJson<AgentCreateResponse>(response, 'Claude Agent create')
  if (!json.id) throw new Error('Claude Agent create response did not include an agent id')
  return json.id
}

async function createEnvironment(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
}): Promise<string> {
  const body = {
    name: 'copse-managed-env',
    config: { type: 'cloud', networking: { type: 'unrestricted' } },
  }
  const response = await input.fetchImpl(joinUrl(input.baseUrl, '/v1/environments'), {
    method: 'POST',
    headers: authHeaders(input.apiKey),
    body: JSON.stringify(body),
  })
  const json = await readJson<EnvironmentCreateResponse>(response, 'Claude Agent environment')
  if (!json.id) throw new Error('Claude Agent environment response did not include an id')
  return json.id
}

async function createSession(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  agentId: string
  environmentId: string
  repository: string
  githubToken: string
  title: string
}): Promise<string> {
  const body = {
    agent: input.agentId,
    environment_id: input.environmentId,
    title: input.title,
    resources: [
      {
        type: 'github_repository',
        url: input.repository,
        mount_path: MANAGED_AGENT_REPO_MOUNT_PATH,
        // Used server-side only to clone and wire the git remote; per the API it
        // is never echoed back and the agent never handles it directly.
        authorization_token: input.githubToken,
      },
    ],
  }
  const response = await input.fetchImpl(joinUrl(input.baseUrl, '/v1/sessions'), {
    method: 'POST',
    headers: authHeaders(input.apiKey),
    body: JSON.stringify(body),
  })
  const json = await readJson<SessionCreateResponse>(response, 'Claude Agent session')
  if (!json.id) throw new Error('Claude Agent session response did not include an id')
  return json.id
}

function eventsBody(prompt: PromptPayload): string {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt.text }]
  for (const image of prompt.images ?? []) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mimeType, data: image.data },
    })
  }
  return JSON.stringify({ events: [{ type: 'user.message', content }] })
}

async function sendUserMessage(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  sessionId: string
  prompt: PromptPayload
}): Promise<void> {
  const response = await input.fetchImpl(
    joinUrl(input.baseUrl, `/v1/sessions/${encodeURIComponent(input.sessionId)}/events`),
    {
      method: 'POST',
      headers: authHeaders(input.apiKey),
      body: eventsBody(input.prompt),
    },
  )
  if (!response.ok) {
    const details = await response.text()
    throw new Error(
      `Claude Agent message send failed with HTTP ${String(response.status)}${details ? `: ${details}` : ''}`,
    )
  }
}

async function interruptSession(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  sessionId: string
}): Promise<void> {
  const response = await input.fetchImpl(
    joinUrl(input.baseUrl, `/v1/sessions/${encodeURIComponent(input.sessionId)}/events`),
    {
      method: 'POST',
      headers: authHeaders(input.apiKey),
      body: JSON.stringify({ events: [{ type: 'user.interrupt' }] }),
    },
  )
  if (!response.ok && response.status !== 409) {
    const details = await response.text()
    throw new Error(
      `Claude Agent interrupt failed with HTTP ${String(response.status)}${details ? `: ${details}` : ''}`,
    )
  }
}

async function fetchSessionUsage(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  sessionId: string
}): Promise<{ inputTokens: number; outputTokens: number }> {
  const response = await input.fetchImpl(
    joinUrl(input.baseUrl, `/v1/sessions/${encodeURIComponent(input.sessionId)}`),
    { headers: authHeaders(input.apiKey) },
  )
  const json = await readJson<SessionGetResponse>(response, 'Claude Agent usage')
  return {
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
  }
}

/**
 * Open the SSE stream, then drive it. Managed Agents only delivers events
 * emitted *after* the stream attaches, so the caller must send the user message
 * via `afterOpen` once the stream is live to avoid a missed-events race.
 */
async function streamSession(input: {
  fetchImpl: typeof fetch
  baseUrl: string
  apiKey: string
  sessionId: string
  signal: AbortSignal
  onChunk: (chunk: StreamChunk) => void
  afterOpen: () => Promise<void>
}): Promise<{ assistantText: string; terminalStatus: string | null }> {
  const response = await input.fetchImpl(
    joinUrl(input.baseUrl, `/v1/sessions/${encodeURIComponent(input.sessionId)}/events/stream`),
    {
      headers: { ...authHeaders(input.apiKey), Accept: 'text/event-stream' },
      signal: input.signal,
    },
  )
  if (!response.ok) {
    const details = await response.text()
    throw new Error(
      `Claude Agent stream failed with HTTP ${String(response.status)}${details ? `: ${details}` : ''}`,
    )
  }
  if (!response.body) throw new Error('Claude Agent stream response did not include a body')

  // Stream is attached; now it is safe to send the user message.
  await input.afterOpen()

  const state = createManagedAgentStreamState()
  for await (const event of parseSseStream(response.body)) {
    for (const chunk of managedAgentEventToChunks(event, state)) input.onChunk(chunk)
    if (state.done) break
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
    console.warn('[managed-agent] branch lookup failed:', err)
  }
  const preamble = buildRemoteAgentContextPreamble({ priorMessages, branch })
  if (!preamble) return prompt
  return { ...prompt, text: `${preamble}\n\n--- New message ---\n${prompt.text}` }
}

function buildLaunchNotice(reused: boolean): string {
  const verb = reused ? 'Continuing on' : 'Running on'
  return `_${verb} Claude Agent — work happens on a remote sandbox and lands on a branch / PR, not in this local workspace._\n\n`
}

/**
 * Run a single turn on Claude Managed Agents. Mirrors the Cursor adapter's
 * contract (same options/result) so the dispatcher in remote-agent-client can
 * route to either provider transparently.
 */
export async function runManagedAgentFromSettings(
  options: RemoteAgentRunOptions,
): Promise<RemoteAgentRunResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = resolveManagedBaseUrl()
  const apiKey = resolveAnthropicApiKey()
  const prompt = promptPayloadFromUserContent(options.userPrompt)
  if (!prompt.text.trim() && !prompt.images?.length) {
    throw new Error('Claude Agent prompt cannot be empty.')
  }

  const priorSession = readSession(options.threadId)
  const canReuse =
    priorSession?.provider === REMOTE_AGENT_PROVIDER_ANTHROPIC && priorSession.baseUrl === baseUrl

  let session: ManagedAgentSession
  let turnPrompt: PromptPayload
  if (priorSession && canReuse) {
    session = priorSession
    // The remote session already holds the repo mount and prior history, so a
    // follow-up is just the new message — no context preamble needed.
    turnPrompt = prompt
  } else {
    const githubToken = resolveGithubToken()
    const repository = await resolveRemoteAgentRepository()
    const owner = parseGithubOwnerRepo(repository)
    const system = buildManagedAgentSystemPrompt({
      mountPath: MANAGED_AGENT_REPO_MOUNT_PATH,
      branchPrefix: DEFAULT_MANAGED_AGENT_BRANCH_PREFIX,
      // Branch from the project's current local branch (falls back to the repo
      // default when it isn't pushed to the remote).
      startingRef: (await getCurrentBranchName())?.trim() || '',
      autoCreatePR: getSetting<boolean>('remoteAgentAutoCreatePR', true),
      workOnCurrentBranch: getSetting<boolean>('remoteAgentWorkOnCurrentBranch', false),
    })
    const agentId = await createAgent({ fetchImpl, baseUrl, apiKey, system })
    const environmentId = await createEnvironment({ fetchImpl, baseUrl, apiKey })
    const sessionId = await createSession({
      fetchImpl,
      baseUrl,
      apiKey,
      agentId,
      environmentId,
      repository,
      githubToken,
      title: owner ? `Copse — ${owner.owner}/${owner.repo}` : 'Copse session',
    })
    session = {
      v: 1,
      provider: REMOTE_AGENT_PROVIDER_ANTHROPIC,
      baseUrl,
      sessionId,
      agentId,
      environmentId,
      usageInput: 0,
      usageOutput: 0,
    }
    turnPrompt = await buildFirstHandoffPrompt(prompt, options.priorMessages ?? [])
  }

  writeSession(options.threadId, session)

  options.onChunk({ type: 'text', text: buildLaunchNotice(canReuse) })

  const onAbort = (): void => {
    void interruptSession({ fetchImpl, baseUrl, apiKey, sessionId: session.sessionId }).catch(
      (err: unknown) => {
        console.warn('[managed-agent] interrupt failed:', err)
      },
    )
  }
  options.signal.addEventListener('abort', onAbort, { once: true })

  try {
    const { assistantText, terminalStatus } = await streamSession({
      fetchImpl,
      baseUrl,
      apiKey,
      sessionId: session.sessionId,
      signal: options.signal,
      onChunk: options.onChunk,
      afterOpen: () =>
        sendUserMessage({
          fetchImpl,
          baseUrl,
          apiKey,
          sessionId: session.sessionId,
          prompt: turnPrompt,
        }),
    })

    let deltaInput = 0
    let deltaOutput = 0
    try {
      const cumulative = await fetchSessionUsage({
        fetchImpl,
        baseUrl,
        apiKey,
        sessionId: session.sessionId,
      })
      // Session usage is cumulative across all turns; report only this turn's
      // delta and persist the new running total.
      deltaInput = Math.max(0, cumulative.inputTokens - session.usageInput)
      deltaOutput = Math.max(0, cumulative.outputTokens - session.usageOutput)
      session.usageInput = cumulative.inputTokens
      session.usageOutput = cumulative.outputTokens
      writeSession(options.threadId, session)
      if (deltaInput || deltaOutput) {
        options.onChunk({
          type: 'usage',
          model: `${REMOTE_AGENT_MODEL_PREFIX}${REMOTE_AGENT_PROVIDER_ANTHROPIC}`,
          inputTokens: deltaInput,
          outputTokens: deltaOutput,
        })
      }
    } catch (err) {
      console.warn('[managed-agent] usage fetch failed:', err)
    }

    options.onChunk(
      terminalStatus ? { type: 'done', stopReason: terminalStatus } : { type: 'done' },
    )
    return {
      assistantText,
      inputTokens: deltaInput,
      outputTokens: deltaOutput,
      messages: assistantText ? [{ role: 'assistant', content: assistantText }] : [],
    }
  } finally {
    options.signal.removeEventListener('abort', onAbort)
  }
}
