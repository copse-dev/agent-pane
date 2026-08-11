import { z } from 'zod'
import type { ParallelSearchMode } from '@copse/agent/plugins/parallel-search-plugin.ts'
import { truncateCommandOutput } from './exec/subprocess-output-cap.ts'

export const PARALLEL_SEARCH_API_URL = 'https://api.parallel.ai/v1/search'
export const PARALLEL_SEARCH_PROVIDER_ID = 'parallel'
export const PARALLEL_SEARCH_OUTPUT_MAX_BYTES = 25_000
const PARALLEL_SEARCH_TIMEOUT_MS = 15_000

export interface ParallelSearchRequest {
  objective: string
  searchQueries: readonly string[]
  mode: ParallelSearchMode
}

const parallelSearchResultSchema = z
  .object({
    url: z.string(),
    title: z.string(),
    publish_date: z.string().nullable().optional(),
    excerpts: z.array(z.string()).optional(),
  })
  .loose()

const parallelSearchResponseSchema = z
  .object({
    search_id: z.string().optional(),
    results: z.array(parallelSearchResultSchema),
    warnings: z.unknown().optional(),
    usage: z.array(z.object({ name: z.string(), count: z.number() }).loose()).optional(),
  })
  .loose()

export type ParallelSearchResponse = z.infer<typeof parallelSearchResponseSchema>

function parallelSearchHttpError(status: number): string {
  if (status === 401 || status === 403) {
    return 'Parallel rejected the API key. Update it in Settings → Plugins → copse.parallel-search.'
  }
  if (status === 402) {
    return 'Parallel reported insufficient credits. Add funds to the account linked to this API key.'
  }
  if (status === 429) return 'Parallel Search rate limit exceeded. Wait and try again.'
  return `Parallel Search returned HTTP ${String(status)}.`
}

function formatWarnings(warnings: unknown): string | null {
  if (warnings === undefined || warnings === null) return null
  if (typeof warnings === 'string') return warnings
  try {
    return JSON.stringify(warnings)
  } catch {
    return 'Parallel adjusted or warned about the request.'
  }
}

export function formatParallelSearchResponse(response: ParallelSearchResponse): string {
  const sections = response.results.map((result, index) => {
    const lines = [`${String(index + 1)}. ${result.title}`, `URL: ${result.url}`]
    if (result.publish_date) lines.push(`Published: ${result.publish_date}`)
    const excerpts = result.excerpts ?? []
    if (excerpts.length > 0) lines.push('', ...excerpts)
    return lines.join('\n')
  })
  const warning = formatWarnings(response.warnings)
  if (warning) sections.push(`Warnings: ${warning}`)
  if (response.usage && response.usage.length > 0) {
    sections.push(
      `Usage: ${response.usage.map((item) => `${item.name} × ${String(item.count)}`).join(', ')}`,
    )
  }
  if (sections.length === 0) return 'Parallel Search returned no results.'
  return truncateCommandOutput(sections.join('\n\n'), PARALLEL_SEARCH_OUTPUT_MAX_BYTES)
}

export async function requestParallelSearch(
  apiKey: string,
  request: ParallelSearchRequest,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ParallelSearchResponse> {
  const response = await fetchImpl(PARALLEL_SEARCH_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      objective: request.objective,
      search_queries: request.searchQueries,
      mode: request.mode,
    }),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(PARALLEL_SEARCH_TIMEOUT_MS)]),
  })
  if (!response.ok) throw new Error(parallelSearchHttpError(response.status))
  const parsed = parallelSearchResponseSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new Error('Parallel Search returned an unexpected response shape.')
  }
  return parsed.data
}
