/**
 * Live Cursor Cloud Agent model catalog (`GET /v1/models`). Used by the footer
 * / Settings model picker so each Cursor model appears as its own dropdown row,
 * mirroring how OpenRouter and ACP expand their catalogs.
 */
import {
  DEFAULT_CURSOR_AGENT_BASE_URL,
  REMOTE_AGENT_PROVIDER_CURSOR,
} from '@shared/remote-agent.ts'
import { getApiKey, getSetting } from '../storage/settings.ts'
import { validateRemoteAgentBaseUrl } from '../security/web-origin-policy.ts'
import { FETCH_TIMEOUTS } from '../fetch-timeouts.ts'
import { isRecord } from '@shared/unknown-value.ts'

export interface CursorCloudModelOption {
  id: string
  label: string
}

function cursorAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`
}

/**
 * Resolve the Cursor API base used for catalog + validation. Honors
 * `remoteAgentBaseUrl` (same setting the create-agent path uses) so e2e fixtures
 * and custom endpoints stay consistent.
 */
export function resolveCursorCloudApiBase(): string {
  const raw = getSetting<string>('remoteAgentBaseUrl', '').trim()
  if (!raw) return DEFAULT_CURSOR_AGENT_BASE_URL
  try {
    validateRemoteAgentBaseUrl(raw)
    return raw.replace(/\/+$/, '')
  } catch (err) {
    console.warn('[cursor-cloud-models] ignoring invalid remoteAgentBaseUrl:', err)
    return DEFAULT_CURSOR_AGENT_BASE_URL
  }
}

function resolveCursorApiKey(): string | null {
  return getApiKey(REMOTE_AGENT_PROVIDER_CURSOR) ?? process.env['CURSOR_API_KEY'] ?? null
}

export function parseCursorCloudModelsPayload(json: unknown): CursorCloudModelOption[] {
  if (!isRecord(json)) return []
  const items = json['items']
  if (!Array.isArray(items)) return []
  const out: CursorCloudModelOption[] = []
  const seen = new Set<string>()
  for (const row of items) {
    if (!isRecord(row)) continue
    const rec = row
    const id = typeof rec['id'] === 'string' ? rec['id'].trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const displayName = typeof rec['displayName'] === 'string' ? rec['displayName'].trim() : ''
    out.push({ id, label: displayName || id })
  }
  return out
}

async function fetchCursorCloudModels(input: {
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
}): Promise<CursorCloudModelOption[]> {
  const fetchImpl = input.fetchImpl ?? fetch
  const res = await fetchImpl(`${input.baseUrl.replace(/\/+$/, '')}/v1/models`, {
    headers: { Authorization: cursorAuthHeader(input.apiKey) },
    signal: AbortSignal.timeout(FETCH_TIMEOUTS.modelList),
  })
  if (!res.ok) {
    throw new Error(
      `Cursor models failed with HTTP ${String(res.status)}${res.statusText ? ` ${res.statusText}` : ''}`,
    )
  }
  return parseCursorCloudModelsPayload(await res.json())
}

const MODELS_TTL_MS = 5 * 60_000
let cache: {
  key: string
  at: number
  models: CursorCloudModelOption[]
} | null = null

export function invalidateCursorCloudModelsCache(): void {
  cache = null
}

/** Recommended Cursor Cloud Agent models for the picker (cached). */
export async function listCursorCloudModels(options?: {
  fetchImpl?: typeof fetch
}): Promise<CursorCloudModelOption[]> {
  const apiKey = resolveCursorApiKey()
  if (!apiKey) return []

  const baseUrl = resolveCursorCloudApiBase()
  const cacheKey = `${baseUrl}\0${apiKey}`
  const now = Date.now()
  if (cache && cache.key === cacheKey && now - cache.at < MODELS_TTL_MS) return cache.models

  try {
    const models = await fetchCursorCloudModels({
      baseUrl,
      apiKey,
      ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })
    cache = { key: cacheKey, at: now, models }
    return models
  } catch (err) {
    console.warn('[cursor-cloud-models] catalog fetch failed:', err)
    return []
  }
}
