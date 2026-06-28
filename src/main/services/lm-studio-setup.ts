import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PREFERRED_MODEL_IDS } from '@shared/preferred-models.ts'
import { fetchLmStudioModelsCached, lmStudioApiKey, lmStudioOrigin } from './lm-studio-models.ts'
import { getSetting } from './settings.ts'
import { DEFAULT_LM_STUDIO_URL } from '@shared/lm-studio-defaults.ts'
import { FETCH_TIMEOUTS } from './fetch-timeouts.ts'

export interface LmStudioDetection {
  serverRunning: boolean
  serverUrl: string
  installDetected: boolean
  models: string[]
  preferredPresent: string[]
  preferredMissing: string[]
  error?: string
}

export interface LmStudioDownloadJob {
  ok: boolean
  jobId?: string
  status?: string
  totalSizeBytes?: number
  error?: string
}

export interface LmStudioDownloadStatus {
  ok: boolean
  jobId: string
  status?: string
  totalSizeBytes?: number
  downloadedBytes?: number
  error?: string
}

export function detectLmStudioInstall(): boolean {
  const candidates: string[] = []
  if (process.platform === 'darwin') {
    candidates.push('/Applications/LM Studio.app')
  } else if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA']
    if (local) candidates.push(join(local, 'Programs', 'LM Studio', 'LM Studio.exe'))
  } else {
    candidates.push(
      join(homedir(), '.lmstudio'),
      join(homedir(), '.local', 'share', 'LM Studio'),
      '/opt/LM Studio/lm-studio',
    )
  }
  return candidates.some((p) => existsSync(p))
}

export async function detectLmStudio(url?: string, apiKey?: string): Promise<LmStudioDetection> {
  const serverUrl = (url ?? getSetting<string>('localServerUrl', DEFAULT_LM_STUDIO_URL)).replace(
    /\/$/,
    '',
  )
  const result = await fetchLmStudioModelsCached(serverUrl, apiKey)
  const models = result.models.map((m) => m.id)
  const preferredPresent = PREFERRED_MODEL_IDS.filter((id) => models.includes(id))
  const preferredMissing = PREFERRED_MODEL_IDS.filter((id) => !models.includes(id))

  return {
    serverRunning: result.ok,
    serverUrl,
    installDetected: detectLmStudioInstall(),
    models,
    preferredPresent,
    preferredMissing,
    ...(result.error ? { error: result.error } : {}),
  }
}

function parseDownloadResponse(json: unknown): LmStudioDownloadJob {
  const row = json as Record<string, unknown>
  const status = typeof row['status'] === 'string' ? row['status'] : undefined
  const jobId = typeof row['job_id'] === 'string' ? row['job_id'] : undefined
  const totalSizeBytes =
    typeof row['total_size_bytes'] === 'number' ? row['total_size_bytes'] : undefined
  if (!status) {
    return { ok: false, error: 'Unexpected download response' }
  }
  return {
    ok: true,
    status,
    ...(jobId ? { jobId } : {}),
    ...(totalSizeBytes !== undefined ? { totalSizeBytes } : {}),
  }
}

export async function downloadLmStudioModel(
  modelId: string,
  openAiBaseUrl: string,
  apiKey?: string,
): Promise<LmStudioDownloadJob> {
  const origin = lmStudioOrigin(openAiBaseUrl)
  const key = lmStudioApiKey(apiKey)
  try {
    const res = await fetch(`${origin}/api/v1/models/download`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.downloadStart),
    })
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const errJson = (await res.json()) as { error?: { message?: string } }
        if (errJson.error?.message) detail = errJson.error.message
      } catch {
        /* ignore */
      }
      return { ok: false, error: detail }
    }
    return parseDownloadResponse(await res.json())
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Download request failed',
    }
  }
}

export async function getLmStudioDownloadStatus(
  jobId: string,
  openAiBaseUrl: string,
  apiKey?: string,
): Promise<LmStudioDownloadStatus> {
  const origin = lmStudioOrigin(openAiBaseUrl)
  const key = lmStudioApiKey(apiKey)
  try {
    const res = await fetch(
      `${origin}/api/v1/models/download/status/${encodeURIComponent(jobId)}`,
      {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUTS.downloadStatus),
      },
    )
    if (!res.ok) {
      return { ok: false, jobId, error: `HTTP ${res.status}` }
    }
    const row = (await res.json()) as Record<string, unknown>
    return {
      ok: true,
      jobId,
      ...(typeof row['status'] === 'string' ? { status: row['status'] } : {}),
      ...(typeof row['total_size_bytes'] === 'number'
        ? { totalSizeBytes: row['total_size_bytes'] }
        : {}),
      ...(typeof row['downloaded_bytes'] === 'number'
        ? { downloadedBytes: row['downloaded_bytes'] }
        : {}),
    }
  } catch (err) {
    return {
      ok: false,
      jobId,
      error: err instanceof Error ? err.message : 'Could not fetch download status',
    }
  }
}
