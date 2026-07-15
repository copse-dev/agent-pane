import {
  clampPercent,
  errorMessage,
  isRecord,
  readJsonBody,
  toIsoTimestamp,
} from './internal-utils.ts'
import type {
  FetchLike,
  PlanUsageFetchOptions,
  PlanWindow,
  ProviderPlanResult,
  ProviderPlanUsage,
} from './types.ts'

const HF_USAGE_URL = 'https://huggingface.co/api/settings/billing/usage-v2'

/** 1 nano-USD = 1e-9 USD (HF billing units). */
const NANO_USD = 1_000_000_000

export function huggingFaceMonthBoundsUnix(nowMs: number): { start: number; end: number } {
  const d = new Date(nowMs)
  const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  const endMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  return { start: Math.floor(startMs / 1000), end: Math.floor(endMs / 1000) }
}

export function formatNanoUsd(nano: number): string {
  if (!Number.isFinite(nano)) return '$0'
  const usd = nano / NANO_USD
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(4)}`
}

function parseInferenceProvidersWindow(
  raw: unknown,
  nowMs: number,
): { window: PlanWindow; plan: string | null } | null {
  if (!isRecord(raw)) return null
  const used = raw['usedNanoUsd']
  const limit = raw['limitNanoUsd']
  const included = raw['includedNanoUsd']
  if (typeof used !== 'number' || !Number.isFinite(used)) return null
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null

  const periodEnd = raw['periodEnd'] ?? raw['period_end']
  const includedLabel =
    typeof included === 'number' && Number.isFinite(included) && included > 0
      ? ` · included ${formatNanoUsd(included)}`
      : ''

  return {
    plan: `Inference Providers (${formatNanoUsd(limit)} limit${includedLabel})`,
    window: {
      id: 'inference_providers',
      label: 'Monthly inference',
      usedPercent: clampPercent((used / limit) * 100),
      resetsAt: toIsoTimestamp(periodEnd, nowMs),
    },
  }
}

/**
 * Parse HF `GET /api/settings/billing/usage-v2` JSON into plan windows.
 * Surfaces Inference Providers spend (the Copse-relevant pool); other buckets
 * stay in the schema probe for drift detection.
 */
export function parseHuggingFaceUsage(raw: unknown, nowMs: number = Date.now()): ProviderPlanUsage {
  const root = isRecord(raw) ? raw : {}
  const usage = isRecord(root['usage']) ? root['usage'] : root
  const inferred = parseInferenceProvidersWindow(usage['inferenceProviders'], nowMs)
  const windows: PlanWindow[] = inferred ? [inferred.window] : []
  return {
    provider: 'huggingface',
    plan: inferred?.plan ?? null,
    windows,
    checkedAt: new Date(nowMs).toISOString(),
  }
}

export async function fetchHuggingFacePlanUsage(
  token: string | null | undefined,
  options: PlanUsageFetchOptions = {},
): Promise<ProviderPlanResult> {
  const trimmed = token?.trim()
  if (!trimmed) {
    return {
      status: 'unavailable',
      provider: 'huggingface',
      reason:
        'No Hugging Face token (set HF_TOKEN, save a key in Settings, or run `hf auth login`)',
    }
  }

  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now
  const nowMs = now()
  const { start, end } = huggingFaceMonthBoundsUnix(nowMs)
  const url = `${HF_USAGE_URL}?startDate=${String(start)}&endDate=${String(end)}`

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${trimmed}`,
        Accept: 'application/json',
      },
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const body = await readJsonBody(response, 'Hugging Face plan usage')
    const usage = parseHuggingFaceUsage(body, nowMs)
    if (usage.windows.length === 0) {
      return {
        status: 'unavailable',
        provider: 'huggingface',
        reason: 'Hugging Face billing response had no Inference Providers limit',
      }
    }
    return { status: 'ok', provider: 'huggingface', usage }
  } catch (err) {
    const message = errorMessage(err)
    if (/HTTP 401|HTTP 403/.test(message)) {
      return {
        status: 'unavailable',
        provider: 'huggingface',
        reason:
          'Hugging Face token was rejected for billing (need a user token that can read billing — try a classic token or fine-grained with billing access)',
      }
    }
    return { status: 'error', provider: 'huggingface', message }
  }
}
