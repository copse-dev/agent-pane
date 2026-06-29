// Regenerates src/shared/llm/model-catalog.generated.ts from BerriAI/litellm's
// public model price + context-window catalog.
//
// Fail-fast: any HTTP failure, schema mismatch, or missing/zero value for a
// tracked model aborts with a non-zero exit. We'd rather break the sync
// workflow (which opens a PR) than ship silently-wrong cost estimates again.
//
// Run locally:  npm run sync:models
// Run in CI:    .github/workflows/sync-model-catalog.yml (weekly + manual)
//
// Note on the duplicated TRACKED_MODELS list: this script is run as a Node ESM
// `.mts` (no bundler) so it can't import directly from src/**/*.ts (CommonJS
// in this repo). The canonical list lives in `src/shared/llm/model-catalog.ts`
// and `src/shared/llm/model-catalog.test.ts` asserts every TRACKED_MODELS
// entry has data in the generated catalog — so if the two lists drift, the
// unit suite (which runs in both `npm run check` and the sync workflow) fails.

import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const GENERATED_PATH = resolve('src/shared/llm/model-catalog.generated.ts')

// Mirror of TRACKED_MODELS in src/shared/llm/model-catalog.ts (see header
// comment for why this is duplicated). model-catalog.test.ts enforces parity.
const TRACKED_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-haiku-4-5',
  'gpt-5',
  'gpt-5-mini',
  'gpt-4o',
  'gpt-4o-mini',
] as const

// LiteLLM entries have many optional fields; we only validate what the catalog
// needs. `litellm_provider` is checked separately because the allowed set is
// id-specific (claude-* → 'anthropic', gpt-* → 'openai').
const LitellmEntry = z.object({
  input_cost_per_token: z.number().positive(),
  output_cost_per_token: z.number().positive(),
  max_input_tokens: z.number().int().positive(),
  max_output_tokens: z.number().int().positive(),
  litellm_provider: z.string(),
  cache_read_input_token_cost: z.number().positive().optional(),
  cache_creation_input_token_cost: z.number().positive().optional(),
})

const LitellmCatalog = z.record(z.string(), z.unknown())

interface ResolvedEntry {
  inputPricePerMTok: number
  outputPricePerMTok: number
  cacheReadPricePerMTok?: number
  cacheCreationPricePerMTok?: number
  contextWindow: number
  maxOutputTokens: number
}

function expectedProviderFor(model: string): 'anthropic' | 'openai' {
  if (model.startsWith('claude')) return 'anthropic'
  if (model.startsWith('gpt')) return 'openai'
  throw new Error(
    `[sync-model-catalog] Unknown provider family for tracked model '${model}'. Update expectedProviderFor() to teach the script how to validate it.`,
  )
}

// 0.000003 * 1e6 happens to round cleanly in V8, but 0.0000033 * 1e6 does not.
// toPrecision(6) gives us at most 6 significant digits, which is well below the
// quoted precision on every public price sheet (cents per MTok, ~2-3 decimals).
function perMTok(perToken: number): number {
  return Number((perToken * 1_000_000).toPrecision(6))
}

async function fetchCatalog(): Promise<unknown> {
  const res = await fetch(LITELLM_URL)
  if (!res.ok) {
    throw new Error(`[sync-model-catalog] GET ${LITELLM_URL} → ${res.status} ${res.statusText}`)
  }
  return res.json()
}

function resolveEntries(raw: unknown): Record<string, ResolvedEntry> {
  const catalog = LitellmCatalog.parse(raw)
  const out: Record<string, ResolvedEntry> = {}

  const missing: string[] = []
  const invalid: string[] = []

  for (const model of TRACKED_MODELS) {
    const entry = catalog[model]
    if (entry === undefined) {
      missing.push(model)
      continue
    }
    const parsed = LitellmEntry.safeParse(entry)
    if (!parsed.success) {
      invalid.push(`${model}: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
      continue
    }
    const expected = expectedProviderFor(model)
    if (parsed.data.litellm_provider !== expected) {
      invalid.push(
        `${model}: expected litellm_provider=${expected}, got '${parsed.data.litellm_provider}'`,
      )
      continue
    }
    out[model] = {
      inputPricePerMTok: perMTok(parsed.data.input_cost_per_token),
      outputPricePerMTok: perMTok(parsed.data.output_cost_per_token),
      ...(parsed.data.cache_read_input_token_cost !== undefined
        ? { cacheReadPricePerMTok: perMTok(parsed.data.cache_read_input_token_cost) }
        : {}),
      ...(parsed.data.cache_creation_input_token_cost !== undefined
        ? { cacheCreationPricePerMTok: perMTok(parsed.data.cache_creation_input_token_cost) }
        : {}),
      contextWindow: parsed.data.max_input_tokens,
      maxOutputTokens: parsed.data.max_output_tokens,
    }
  }

  if (missing.length > 0 || invalid.length > 0) {
    const parts: string[] = []
    if (missing.length > 0) parts.push(`missing from upstream catalog: ${missing.join(', ')}`)
    if (invalid.length > 0) parts.push(`invalid entries:\n  - ${invalid.join('\n  - ')}`)
    throw new Error(
      `[sync-model-catalog] Refusing to write catalog — ${parts.join('. ')}.\n` +
        `If a model was renamed or retired upstream, update TRACKED_MODELS in src/shared/llm/model-catalog.ts AND in this script.`,
    )
  }

  return out
}

function renderFile(entries: Record<string, ResolvedEntry>, today: string): string {
  const sortedKeys = Object.keys(entries).sort()
  const body = sortedKeys
    .map((key) => {
      const e = entries[key]!
      const cacheRead =
        e.cacheReadPricePerMTok !== undefined
          ? `, cacheReadPricePerMTok: ${e.cacheReadPricePerMTok}`
          : ''
      const cacheCreation =
        e.cacheCreationPricePerMTok !== undefined
          ? `, cacheCreationPricePerMTok: ${e.cacheCreationPricePerMTok}`
          : ''
      return `  '${key}': { inputPricePerMTok: ${e.inputPricePerMTok}, outputPricePerMTok: ${e.outputPricePerMTok}${cacheRead}${cacheCreation}, contextWindow: ${e.contextWindow}, maxOutputTokens: ${e.maxOutputTokens} },`
    })
    .join('\n')
  return `// AUTO-GENERATED by scripts/sync-model-catalog.mts. Do not edit by hand.
// Source: https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
// Last synced: ${today}

export interface CatalogEntry {
  inputPricePerMTok: number
  outputPricePerMTok: number
  cacheReadPricePerMTok?: number
  cacheCreationPricePerMTok?: number
  contextWindow: number
  maxOutputTokens: number
}

export const MODEL_CATALOG: Record<string, CatalogEntry> = {
${body}
}
`
}

function runPrettier(): void {
  // The emitted file aims to be prettier-clean already, but run prettier so any
  // future formatting changes (line width, trailing commas) reformat the
  // generated file consistently with the rest of the repo.
  execFileSync('npx', ['prettier', '--write', GENERATED_PATH], { stdio: 'inherit' })
}

async function main(): Promise<void> {
  const raw = await fetchCatalog()
  const entries = resolveEntries(raw)
  const today = new Date().toISOString().slice(0, 10)
  const content = renderFile(entries, today)
  // Only rewrite the file if anything would change, so the workflow's
  // `git diff --quiet` step (and local re-runs) stay no-op when LiteLLM hasn't
  // moved. We compare the rendered content against the existing file, ignoring
  // the `Last synced:` header line so a re-run on a day with no upstream
  // changes is a true no-op.
  const existing = await readFile(GENERATED_PATH, 'utf8').catch(() => '')
  const stripSyncDate = (s: string): string =>
    s.replace(/\/\/ Last synced: \d{4}-\d{2}-\d{2}\n/, '')
  if (stripSyncDate(existing) === stripSyncDate(content)) {
    console.log(
      `[sync-model-catalog] No upstream changes for ${TRACKED_MODELS.length} tracked models.`,
    )
    return
  }
  await writeFile(GENERATED_PATH, content, 'utf8')
  runPrettier()
  console.log(
    `[sync-model-catalog] Wrote ${Object.keys(entries).length} entries to ${GENERATED_PATH} (synced ${today}).`,
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
