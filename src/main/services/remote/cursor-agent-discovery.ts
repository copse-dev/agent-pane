/**
 * Spike: surface Cursor cloud agents launched outside Copse as local thread stubs.
 *
 * Cursor's list endpoint only returns durable identity fields (no `repos`). Matching
 * an agent to the open project therefore requires a follow-up `GET /v1/agents/{id}`
 * per candidate — acceptable for a small page (≤100) while we prove the path.
 *
 * Not wired into the sidebar yet; call {@link discoverExternalCursorAgents} (or the
 * `remoteAgent:discoverExternal` IPC) then reload project threads.
 */
import { randomUUID } from 'node:crypto'
import type { Message, Thread } from '@shared/types'
import type { RemoteAgentLink } from '@shared/remote-agent-link.ts'
import {
  DEFAULT_CURSOR_AGENT_BASE_URL,
  REMOTE_AGENT_PROVIDER_CURSOR,
  remoteAgentModelValue,
} from '@shared/remote-agent.ts'
import { getApiKey, getSetting } from '../storage/settings.ts'
import { validateRemoteAgentBaseUrl } from '../security/web-origin-policy.ts'
import { getActiveProjectId } from '../workspace.ts'
import { createThread, loadProjectThreads } from '../thread-store.ts'
import { FETCH_TIMEOUTS } from '../fetch-timeouts.ts'
import { parseGithubOwnerRepo, resolveRemoteAgentRepository } from './remote-agent-shared.ts'
import { seedRemoteAgentSession } from './remote-agent-client.ts'

/** Default page size for the spike (Cursor max is 100). */
export const EXTERNAL_CURSOR_AGENT_LIST_LIMIT = 50

export interface CursorAgentSummary {
  id: string
  name: string
  status: string
  url: string
  createdAt: string
  updatedAt?: string
  latestRunId?: string
}

export interface CursorAgentDetail extends CursorAgentSummary {
  repos: Array<{ url: string; startingRef?: string }>
}

export interface CursorAgentListPage {
  items: CursorAgentSummary[]
  nextCursor?: string
}

export interface ExternalCursorAgentImport {
  threadId: string
  agentId: string
  title: string
  url: string
}

export interface DiscoverExternalCursorAgentsResult {
  imported: ExternalCursorAgentImport[]
  scanned: number
  skippedLinked: number
  skippedWrongRepo: number
  skippedInactive: number
}

export interface DiscoverExternalCursorAgentsOptions {
  projectId?: string | null
  /** Override repository URL used for matching (defaults to active project origin). */
  repositoryUrl?: string | null
  limit?: number
  includeArchived?: boolean
  fetchImpl?: typeof fetch
  /** Injected for tests — defaults to {@link createThread}. */
  createThreadImpl?: typeof createThread
  /** Injected for tests — defaults to {@link loadProjectThreads}. */
  loadThreadsImpl?: typeof loadProjectThreads
  /** Injected for tests — defaults to {@link seedRemoteAgentSession}. */
  seedSessionImpl?: typeof seedRemoteAgentSession
  now?: () => number
  newId?: () => string
}

function cursorAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

function resolveCursorApiBase(): string {
  const raw = getSetting<string>('remoteAgentBaseUrl', '').trim()
  if (!raw) return DEFAULT_CURSOR_AGENT_BASE_URL
  try {
    validateRemoteAgentBaseUrl(raw)
    return raw.replace(/\/+$/, '')
  } catch (err) {
    console.warn('[cursor-agent-discovery] ignoring invalid remoteAgentBaseUrl:', err)
    return DEFAULT_CURSOR_AGENT_BASE_URL
  }
}

function resolveCursorApiKey(): string {
  const apiKey = getApiKey(REMOTE_AGENT_PROVIDER_CURSOR) ?? process.env['CURSOR_API_KEY'] ?? null
  if (!apiKey) {
    throw new Error('Configure a Cursor API key in Settings before discovering cloud agents.')
  }
  return apiKey
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

function parseIsoMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : fallback
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** Parse one list/detail agent row; returns null when required identity fields are missing. */
export function parseCursorAgentSummary(raw: unknown): CursorAgentSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const id = asNonEmptyString(rec['id'])
  const name = asNonEmptyString(rec['name'])
  const status = asNonEmptyString(rec['status'])
  const url = asNonEmptyString(rec['url'])
  const createdAt = asNonEmptyString(rec['createdAt'])
  if (!id || !name || !status || !url || !createdAt) return null
  const updatedAt = asNonEmptyString(rec['updatedAt'])
  const latestRunId = asNonEmptyString(rec['latestRunId'])
  return {
    id,
    name,
    status,
    url,
    createdAt,
    ...(updatedAt ? { updatedAt } : {}),
    ...(latestRunId ? { latestRunId } : {}),
  }
}

export function parseCursorAgentListPage(raw: unknown): CursorAgentListPage {
  if (!raw || typeof raw !== 'object') return { items: [] }
  const rec = raw as Record<string, unknown>
  const itemsRaw = rec['items']
  const items: CursorAgentSummary[] = []
  if (Array.isArray(itemsRaw)) {
    for (const row of itemsRaw) {
      const parsed = parseCursorAgentSummary(row)
      if (parsed) items.push(parsed)
    }
  }
  const nextCursor = asNonEmptyString(rec['nextCursor'])
  return nextCursor ? { items, nextCursor } : { items }
}

export function parseCursorAgentDetail(raw: unknown): CursorAgentDetail | null {
  const summary = parseCursorAgentSummary(raw)
  if (!summary || !raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const reposRaw = rec['repos']
  const repos: Array<{ url: string; startingRef?: string }> = []
  if (Array.isArray(reposRaw)) {
    for (const row of reposRaw) {
      if (!row || typeof row !== 'object') continue
      const repoRec = row as Record<string, unknown>
      const url = asNonEmptyString(repoRec['url'])
      if (!url) continue
      const startingRef = asNonEmptyString(repoRec['startingRef'])
      repos.push(startingRef ? { url, startingRef } : { url })
    }
  }
  return { ...summary, repos }
}

function sameGithubRepo(
  a: { owner: string; repo: string },
  b: { owner: string; repo: string },
): boolean {
  // GitHub owner/repo slugs are case-insensitive.
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
  )
}

/** True when the agent was launched against the same GitHub owner/repo. */
export function cursorAgentMatchesRepository(
  agent: CursorAgentDetail,
  repositoryUrl: string,
): boolean {
  const want = parseGithubOwnerRepo(repositoryUrl)
  if (!want) return false
  for (const repo of agent.repos) {
    const got = parseGithubOwnerRepo(repo.url)
    if (got && sameGithubRepo(got, want)) return true
  }
  return false
}

/** Agent ids already linked on local threads (Copse-launched or previously imported). */
export function collectLinkedCursorAgentIds(threads: readonly Thread[]): Set<string> {
  const linked = new Set<string>()
  for (const thread of threads) {
    const link = thread.remoteAgentLink
    if (link?.provider === REMOTE_AGENT_PROVIDER_CURSOR && link.agentId) {
      linked.add(link.agentId)
    }
  }
  return linked
}

export function buildExternalCursorAgentStub(input: {
  agent: CursorAgentDetail
  repositoryUrl: string
  now: number
  threadId: string
  messageId: string
}): Thread {
  const repoSlug = parseGithubOwnerRepo(input.repositoryUrl)
  const matchedRepo = input.agent.repos.find((repo) => {
    const got = parseGithubOwnerRepo(repo.url)
    return repoSlug !== null && got !== null && sameGithubRepo(got, repoSlug)
  })
  const createdAt = parseIsoMs(input.agent.createdAt, input.now)
  const updatedAt = parseIsoMs(input.agent.updatedAt, createdAt)
  const link: RemoteAgentLink = {
    provider: REMOTE_AGENT_PROVIDER_CURSOR,
    agentId: input.agent.id,
    createdAt,
    ...(input.agent.latestRunId ? { runId: input.agent.latestRunId } : {}),
    ...(matchedRepo?.startingRef ? { branch: matchedRepo.startingRef } : {}),
    ...(repoSlug ? { repo: `${repoSlug.owner}/${repoSlug.repo}` } : {}),
  }
  const notice: Message = {
    id: input.messageId,
    role: 'assistant',
    content:
      `_Imported Cursor cloud agent — [${input.agent.name}](${input.agent.url}). ` +
      `Send a message here to continue that run from Copse._`,
    toolCalls: [],
    createdAt,
  }
  const thread: Thread = {
    id: input.threadId,
    title: input.agent.name,
    status: 'idle',
    messages: [notice],
    usage: { inputTokens: 0, outputTokens: 0 },
    remoteAgentLink: link,
    model: remoteAgentModelValue(REMOTE_AGENT_PROVIDER_CURSOR),
    createdAt,
    updatedAt,
  }
  return thread
}

export async function listCursorAgents(input: {
  baseUrl: string
  apiKey: string
  limit?: number
  cursor?: string
  includeArchived?: boolean
  fetchImpl?: typeof fetch
}): Promise<CursorAgentListPage> {
  const fetchImpl = input.fetchImpl ?? fetch
  const params = new URLSearchParams()
  const limit = input.limit ?? EXTERNAL_CURSOR_AGENT_LIST_LIMIT
  params.set('limit', String(limit))
  params.set('includeArchived', input.includeArchived === true ? 'true' : 'false')
  if (input.cursor) params.set('cursor', input.cursor)
  const response = await fetchImpl(joinUrl(input.baseUrl, `/v1/agents?${params}`), {
    headers: { Authorization: cursorAuthHeader(input.apiKey) },
    signal: AbortSignal.timeout(FETCH_TIMEOUTS.agentDiscovery),
  })
  const json: unknown = await readJsonResponse(response, 'Cursor agent list')
  return parseCursorAgentListPage(json)
}

export async function getCursorAgent(input: {
  baseUrl: string
  apiKey: string
  agentId: string
  fetchImpl?: typeof fetch
}): Promise<CursorAgentDetail> {
  const fetchImpl = input.fetchImpl ?? fetch
  const response = await fetchImpl(
    joinUrl(input.baseUrl, `/v1/agents/${encodeURIComponent(input.agentId)}`),
    {
      headers: { Authorization: cursorAuthHeader(input.apiKey) },
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.agentDiscovery),
    },
  )
  const json: unknown = await readJsonResponse(response, 'Cursor agent get')
  const detail = parseCursorAgentDetail(json)
  if (!detail) throw new Error('Cursor agent get returned an incomplete agent record')
  return detail
}

/**
 * List recent Cursor cloud agents, keep those for this project's repo that are
 * not already linked, and materialize local stub threads + remote sessions.
 */
export async function discoverExternalCursorAgents(
  options: DiscoverExternalCursorAgentsOptions = {},
): Promise<DiscoverExternalCursorAgentsResult> {
  const projectId = options.projectId === undefined ? getActiveProjectId() : options.projectId
  if (!projectId) {
    throw new Error('Open a project before discovering external Cursor cloud agents.')
  }

  const repositoryUrl =
    options.repositoryUrl === undefined
      ? await resolveRemoteAgentRepository()
      : options.repositoryUrl
  if (!repositoryUrl) {
    throw new Error(
      'Cursor cloud-agent discovery needs a project backed by a GitHub remote so imports can be scoped.',
    )
  }

  const baseUrl = resolveCursorApiBase()
  const apiKey = resolveCursorApiKey()
  const fetchImpl = options.fetchImpl ?? fetch
  const createThreadImpl = options.createThreadImpl ?? createThread
  const loadThreadsImpl = options.loadThreadsImpl ?? loadProjectThreads
  const seedSessionImpl = options.seedSessionImpl ?? seedRemoteAgentSession
  const now = options.now ?? Date.now
  const newId = options.newId ?? randomUUID

  const page = await listCursorAgents({
    baseUrl,
    apiKey,
    limit: options.limit ?? EXTERNAL_CURSOR_AGENT_LIST_LIMIT,
    includeArchived: options.includeArchived ?? false,
    fetchImpl,
  })

  const existing = await loadThreadsImpl(projectId)
  const linkedIds = collectLinkedCursorAgentIds(existing)

  let skippedLinked = 0
  let skippedInactive = 0
  const candidates: CursorAgentSummary[] = []
  for (const agent of page.items) {
    if (linkedIds.has(agent.id)) {
      skippedLinked += 1
      continue
    }
    if (agent.status !== 'ACTIVE') {
      skippedInactive += 1
      continue
    }
    candidates.push(agent)
  }

  const details = await Promise.all(
    candidates.map((agent) =>
      getCursorAgent({ baseUrl, apiKey, agentId: agent.id, fetchImpl }).catch((err: unknown) => {
        console.warn(`[cursor-agent-discovery] get ${agent.id} failed:`, err)
        return null
      }),
    ),
  )

  let skippedWrongRepo = 0
  const imported: ExternalCursorAgentImport[] = []
  for (const detail of details) {
    if (!detail) continue
    if (!cursorAgentMatchesRepository(detail, repositoryUrl)) {
      skippedWrongRepo += 1
      continue
    }
    const threadId = newId()
    const messageId = newId()
    const stamp = now()
    const thread = buildExternalCursorAgentStub({
      agent: detail,
      repositoryUrl,
      now: stamp,
      threadId,
      messageId,
    })
    await createThreadImpl(projectId, thread)
    seedSessionImpl({
      threadId,
      provider: REMOTE_AGENT_PROVIDER_CURSOR,
      baseUrl,
      agentId: detail.id,
      url: detail.url,
    })
    imported.push({
      threadId,
      agentId: detail.id,
      title: detail.name,
      url: detail.url,
    })
  }

  return {
    imported,
    scanned: page.items.length,
    skippedLinked,
    skippedWrongRepo,
    skippedInactive,
  }
}
