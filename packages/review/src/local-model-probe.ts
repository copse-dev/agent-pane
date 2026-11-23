// What a local model server says about the model a review is about to use,
// read before any check runs so a review that cannot succeed fails in seconds
// rather than after Stage 0's build and test runs.
//
// The OpenAI-compatible API a review talks through cannot say how much context
// the loaded model has, whether it can see images, or what quantisation it is.
// LM Studio's native catalogue (`/api/v1/models`, `/api/v0/models` on older
// builds) can. The common failure is a model that LM Studio loaded on demand at
// its 4096-token default (`docs/lm-studio-context-persistence.md`): the Stage 1
// context alone is larger, so the reviewer would degrade or fail mid-turn. Any
// other OpenAI-compatible server (Ollama, llama.cpp, mlx-lm) has no such
// catalogue; the probe says it could not check rather than guessing.
import { z } from 'zod'
import { errorMessage } from '@copse/std/errors.ts'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import type { LocalEndpoint } from './provider-selection.ts'
import { REVIEW_CONTEXT_FILL } from './turn.ts'

/** One model as the local server describes it. Every field the server omits is null. */
export interface LocalModelInfo {
  readonly server: 'lmstudio'
  readonly model: string
  /** Whether an instance is loaded now; a model that is not is loaded on first use. */
  readonly loaded: boolean
  /** The loaded instance's context window, in tokens. */
  readonly loadedContextLength: number | null
  /** The most the model supports, in tokens. */
  readonly maxContextLength: number | null
  readonly vision: boolean | null
  readonly quantization: string | null
  /** `gguf` (llama.cpp) or `mlx`. */
  readonly format: string | null
  readonly architecture: string | null
}

export type LocalModelProbe =
  | { readonly status: 'found'; readonly info: LocalModelInfo }
  | { readonly status: 'missing'; readonly available: readonly string[] }
  | { readonly status: 'unknown'; readonly reason: string }

const quantizationSchema = z.union([
  z.string(),
  z.object({ name: z.string().optional(), bits_per_weight: z.number().optional() }),
])

const instanceSchema = z.object({
  id: z.string().optional(),
  identifier: z.string().optional(),
  config: z.object({ context_length: z.number().optional() }).optional(),
})

const modelRowSchema = z.object({
  key: z.string().optional(),
  id: z.string().optional(),
  identifier: z.string().optional(),
  model_key: z.string().optional(),
  type: z.string().optional(),
  format: z.string().optional(),
  compatibility_type: z.string().optional(),
  architecture: z.string().optional(),
  arch: z.string().optional(),
  quantization: quantizationSchema.optional(),
  max_context_length: z.number().optional(),
  loaded_context_length: z.number().optional(),
  state: z.string().optional(),
  capabilities: z
    .union([z.object({ vision: z.boolean().optional() }), z.array(z.string())])
    .optional(),
  loaded_instances: z.array(instanceSchema).optional(),
})
type ModelRow = z.infer<typeof modelRowSchema>

const catalogSchema = z.object({
  models: z.array(z.unknown()).optional(),
  data: z.array(z.unknown()).optional(),
})
const decodeCatalog = decodeWithSchema(catalogSchema)

function positive(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

function rowIds(row: ModelRow): string[] {
  const ids = [row.key, row.id, row.identifier, row.model_key]
  for (const instance of row.loaded_instances ?? []) ids.push(instance.id, instance.identifier)
  return ids.flatMap((id) => (id === undefined || id.length === 0 ? [] : [id]))
}

function rowVision(row: ModelRow): boolean | null {
  const capabilities = row.capabilities
  if (Array.isArray(capabilities)) return capabilities.includes('vision')
  if (capabilities?.vision !== undefined) return capabilities.vision
  if (row.type === 'vlm') return true
  if (row.type === 'llm') return false
  return null
}

function rowInfo(model: string, row: ModelRow): LocalModelInfo {
  const instances = row.loaded_instances ?? []
  const fromInstance = instances
    .map((instance) => positive(instance.config?.context_length))
    .find((length) => length !== null)
  const quantization =
    typeof row.quantization === 'string' ? row.quantization : (row.quantization?.name ?? null)
  return {
    server: 'lmstudio',
    model,
    loaded: instances.length > 0 || row.state === 'loaded',
    loadedContextLength: fromInstance ?? positive(row.loaded_context_length),
    maxContextLength: positive(row.max_context_length),
    vision: rowVision(row),
    quantization,
    format: row.format ?? row.compatibility_type ?? null,
    architecture: row.architecture ?? row.arch ?? null,
  }
}

/** Describe `model` from a catalogue response's text, or null when the text is not one. */
export function parseLocalModelCatalog(model: string, text: string): LocalModelProbe | null {
  const catalog = safeJsonParse(text, decodeCatalog)
  if (catalog === null) return null
  const list = catalog.models ?? catalog.data
  if (list === undefined) return null
  const rows: ModelRow[] = []
  for (const value of list) {
    const parsed = modelRowSchema.safeParse(value)
    if (parsed.success) rows.push(parsed.data)
  }
  // LM Link lists a model once per device that has it, under the same key, and
  // those rows can differ (format, vision, the context each is loaded with).
  // The server answers with a loaded copy, so a loaded row describes the model
  // a review will talk to; of several, the smallest loaded context is the one
  // every copy can hold.
  const matches = rows
    .filter((candidate) => rowIds(candidate).includes(model))
    .map((candidate) => rowInfo(model, candidate))
  const loaded = matches
    .filter((info) => info.loaded)
    .sort(
      (a, b) =>
        (a.loadedContextLength ?? Number.POSITIVE_INFINITY) -
        (b.loadedContextLength ?? Number.POSITIVE_INFINITY),
    )
  const info = loaded[0] ?? matches[0]
  if (info !== undefined) return { status: 'found', info }
  return {
    status: 'missing',
    available: [
      ...new Set(
        rows
          .filter((candidate) => candidate.type !== 'embedding' && candidate.type !== 'embeddings')
          .map((candidate) => rowIds(candidate)[0] ?? '')
          .filter((id) => id.length > 0),
      ),
    ],
  }
}

/** The server origin behind an OpenAI-compatible base URL (`…/v1` dropped). */
export function serverOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')
}

export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>

/** Ask the server behind `endpoint` about `model`. Never throws. */
export async function probeLocalModel(
  endpoint: LocalEndpoint,
  model: string,
  options: { readonly fetch?: ProbeFetch; readonly timeoutMs?: number } = {},
): Promise<LocalModelProbe> {
  const fetchImpl = options.fetch ?? fetch
  const origin = serverOrigin(endpoint.baseUrl)
  const reasons: string[] = []
  for (const path of ['/api/v1/models', '/api/v0/models']) {
    try {
      const response = await fetchImpl(`${origin}${path}`, {
        headers: { Authorization: `Bearer ${endpoint.apiKey}` },
        // Never forward the bearer to a redirect target.
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      })
      if (!response.ok) {
        reasons.push(`${path}: HTTP ${String(response.status)}`)
        continue
      }
      const probe = parseLocalModelCatalog(model, await response.text())
      if (probe !== null) return probe
      reasons.push(`${path}: not a model catalogue`)
    } catch (err) {
      reasons.push(`${path}: ${errorMessage(err)}`)
    }
  }
  return { status: 'unknown', reason: reasons.join('; ') }
}

/**
 * The context a review needs from a model, in tokens: the Stage 1 context at
 * a conservative three characters per token, plus the system prompt, the tool
 * schemas and room for a dozen tool results, within the share of the window a
 * review turn lets its history fill (`REVIEW_CONTEXT_FILL`).
 */
export function requiredContextTokens(budgetChars: number): number {
  return Math.ceil((Math.ceil(budgetChars / 3) + 16_384) / REVIEW_CONTEXT_FILL)
}

/** One route the pre-flight checks: a model behind a local server. */
export interface LocalRoute {
  readonly model: string
  readonly endpoint: LocalEndpoint
}

export interface LocalPreflight {
  /** What each checked model's server said, by model id. */
  readonly models: ReadonlyMap<string, LocalModelInfo>
  /** Reasons the review cannot run as configured. */
  readonly problems: readonly string[]
  /** What could not be checked, or is worth knowing before a long run. */
  readonly notes: readonly string[]
}

/**
 * Check every local route before a review starts: the model exists, and its
 * loaded context can hold the review. `minContextTokens` 0 skips the context
 * check (an operator who knows the server better than its catalogue).
 */
export async function preflightLocalModels(
  routes: readonly LocalRoute[],
  options: { readonly minContextTokens: number; readonly fetch?: ProbeFetch },
): Promise<LocalPreflight> {
  const models = new Map<string, LocalModelInfo>()
  const problems: string[] = []
  const notes: string[] = []
  const seen = new Set<string>()
  for (const route of routes) {
    const key = `${route.endpoint.baseUrl}\n${route.model}`
    if (seen.has(key)) continue
    seen.add(key)
    const probe = await probeLocalModel(
      route.endpoint,
      route.model,
      options.fetch === undefined ? {} : { fetch: options.fetch },
    )
    const where = route.endpoint.baseUrl
    if (probe.status === 'unknown') {
      notes.push(
        `could not read ${route.model}'s details from ${where} (${probe.reason}); its context length was not checked`,
      )
      continue
    }
    if (probe.status === 'missing') {
      const available = probe.available.length > 0 ? probe.available.join(', ') : 'none'
      problems.push(`${where} has no model ${route.model} (available: ${available})`)
      continue
    }
    const { info } = probe
    models.set(route.model, info)
    const needed = options.minContextTokens
    if (needed <= 0) continue
    const fix = `reload it with \`lms load ${route.model} --context-length ${String(needed)}\`, pass a smaller --budget-chars, or --min-context 0 to skip this check`
    if (info.maxContextLength !== null && info.maxContextLength < needed) {
      problems.push(
        `${route.model} supports at most ${String(info.maxContextLength)} tokens of context; this review needs about ${String(needed)} (pass a smaller --budget-chars)`,
      )
    } else if (info.loaded && info.loadedContextLength !== null) {
      if (info.loadedContextLength < needed) {
        problems.push(
          `${route.model} is loaded with a ${String(info.loadedContextLength)}-token context; this review needs about ${String(needed)}: ${fix}`,
        )
      }
    } else if (!info.loaded) {
      notes.push(
        `${route.model} is not loaded; the server will load it on first use with its saved settings, which must give at least ${String(needed)} tokens of context (\`lms load ${route.model} --context-length ${String(needed)}\`)`,
      )
    }
  }
  return { models, problems, notes }
}
