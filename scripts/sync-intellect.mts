// Regenerates packages/llm/src/model-intellect.generated.ts from the curated
// measurement file scripts/data/intellect-scores.json. Companion to
// sync-model-catalog.mts (cloud pricing) and sync-local-models.mts (local
// benchmark scores); this one carries the single composite "intellect" axis
// (Artificial Analysis Intelligence Index) for cloud AND local model ids.
//
// Design notes:
//   - The JSON is the reviewed source of truth: measurements are cited facts
//     (value + source + asOf + indexVersion), never guesses. This script only
//     validates and emits — it does not scrape. A future step can fetch from the
//     Artificial Analysis API when ARTIFICIAL_ANALYSIS_API_KEY is configured
//     (their free tier requires attribution — already carried in the JSON).
//   - Index versions renormalise, so scores are only comparable within one
//     version. canonicalVersion is the permanent ruler; other versions are
//     translated onto it via equating maps fitted from anchor models (models
//     with entries under both versions of a hop).
//   - STABILITY: fitted maps are crystallised back into the JSON at first fit
//     and reused verbatim on later runs, so adding new anchors never silently
//     shifts previously-equated values. Pass --refit to deliberately refit
//     every configured hop (a reviewed, diff-visible event).
//
// Run locally:  npm run sync:intellect            (validate + emit, reuse fits)
//               npm run sync:intellect -- --refit (deliberately refit all hops)
//
// API refresh (the scalable data channel):
//   ARTIFICIAL_ANALYSIS_API_KEY=... npm run sync:intellect -- --from-api --index-version=v4.1
// Fetches Artificial Analysis' model list and refreshes/adds measurements for
// models ALREADY KNOWN to the seed file (matched by id or alias — the API never
// introduces a model id on its own, so every plotted model remains a reviewed
// decision). --index-version is required because the API reports current-index
// values without naming the version; the operator pins which scale the fetched
// cohort belongs to. Attribution is required by AA's free tier and is already
// carried in the JSON + generated output.

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  MIN_RECOMMENDED_ANCHORS,
  fitLinearEquating,
  type AnchorPair,
  type EquatingMap,
} from '../packages/llm/src/intellect-equating.ts'

const DATA_PATH = resolve('scripts/data/intellect-scores.json')
const GENERATED_PATH = resolve('packages/llm/src/model-intellect.generated.ts')

interface Measurement {
  modelId: string
  value: number
  indexVersion: string
  source: string
  asOf: string
  /**
   * Alternate id/label forms the same weights appear under across providers
   * (OpenRouter ids, ACP picker labels). Lookup keys only — they never create
   * a second measurement.
   */
  aliases?: string[]
}

interface DataFile {
  canonicalVersion: string
  attribution: string
  scores: Measurement[]
  /** Version hops we intend to fit, e.g. { "from": "v4.2", "to": "v4.1" }. */
  equatingPairs: Array<{ from: string; to: string }>
  /** Crystallised fits — written back by this script, reused on later runs. */
  equating: EquatingMap[]
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function fail(message: string): never {
  throw new Error(`[sync-intellect] ${message}`)
}

function validate(data: DataFile): void {
  if (!data.canonicalVersion) fail('canonicalVersion is required')
  if (!data.attribution) fail('attribution is required')
  const seen = new Set<string>()
  for (const m of data.scores) {
    // The JSON is hand-edited, so fields may be absent despite the type.
    const where = `score for '${m.modelId || '?'}' (${m.indexVersion || '?'})`
    if (!m.modelId) fail(`${where}: modelId is required`)
    if (!Number.isFinite(m.value)) fail(`${where}: value must be a finite number`)
    if (!m.indexVersion) fail(`${where}: indexVersion is required`)
    if (!m.source || m.source.trim().length < 10) {
      fail(`${where}: source citation is required (facts, not vibes)`)
    }
    if (!isIsoDate(m.asOf)) fail(`${where}: asOf must be an ISO date (YYYY-MM-DD)`)
    const key = `${m.modelId}@${m.indexVersion}`
    if (seen.has(key)) fail(`duplicate measurement ${key}`)
    seen.add(key)
  }
  const aliasOwner = new Map<string, string>()
  for (const m of data.scores) {
    for (const alias of m.aliases ?? []) {
      const owner = aliasOwner.get(alias)
      if (owner !== undefined && owner !== m.modelId) {
        fail(`alias '${alias}' claimed by both '${owner}' and '${m.modelId}'`)
      }
      if (alias === m.modelId) fail(`alias '${alias}' duplicates its own modelId`)
      aliasOwner.set(alias, m.modelId)
    }
  }
  for (const map of data.equating) {
    if (!data.equatingPairs.some((p) => p.from === map.from && p.to === map.to)) {
      fail(`stored fit ${map.from}→${map.to} has no matching equatingPairs entry`)
    }
  }
}

/** Anchor pairs for one hop: models measured under both versions. */
function anchorsFor(scores: readonly Measurement[], from: string, to: string): AnchorPair[] {
  const byModel = new Map<string, Map<string, number>>()
  for (const m of scores) {
    const versions = byModel.get(m.modelId) ?? new Map<string, number>()
    versions.set(m.indexVersion, m.value)
    byModel.set(m.modelId, versions)
  }
  const pairs: AnchorPair[] = []
  for (const versions of byModel.values()) {
    const fromValue = versions.get(from)
    const toValue = versions.get(to)
    if (fromValue !== undefined && toValue !== undefined) pairs.push({ fromValue, toValue })
  }
  return pairs
}

/**
 * Return the crystallised fit for each configured hop, fitting only hops that
 * have no stored fit yet (or every hop when refit is set). New fits use today's
 * date; reused fits keep their original fittedAsOf — that stability is the
 * point.
 */
function resolveEquating(data: DataFile, today: string, refit: boolean): EquatingMap[] {
  const out: EquatingMap[] = []
  for (const pair of data.equatingPairs) {
    const stored = data.equating.find((m) => m.from === pair.from && m.to === pair.to)
    if (stored && !refit) {
      out.push(stored)
      continue
    }
    const anchors = anchorsFor(data.scores, pair.from, pair.to)
    if (anchors.length < 2) {
      fail(
        `equating ${pair.from}→${pair.to}: only ${String(anchors.length)} anchor model(s); ` +
          'need ≥2 models measured under both versions',
      )
    }
    if (anchors.length < MIN_RECOMMENDED_ANCHORS) {
      console.warn(
        `[sync-intellect] WARNING: equating ${pair.from}→${pair.to} fitted from only ` +
          `${String(anchors.length)} anchors (recommended ≥${String(MIN_RECOMMENDED_ANCHORS)}); ` +
          'treat translated values with caution and add anchors',
      )
    }
    out.push(fitLinearEquating(pair.from, pair.to, anchors, today))
  }
  return out
}

function renderFile(data: DataFile, maps: readonly EquatingMap[], today: string): string {
  const byModel = new Map<string, Measurement[]>()
  for (const m of data.scores) {
    const list = byModel.get(m.modelId) ?? []
    list.push(m)
    byModel.set(m.modelId, list)
  }
  const body = [...byModel.keys()]
    .sort()
    .map((id) => {
      const rows = (byModel.get(id) ?? [])
        .sort((a, b) => a.indexVersion.localeCompare(b.indexVersion))
        .map(
          (m) =>
            `    { value: ${String(m.value)}, indexVersion: '${m.indexVersion}', source: '${m.source.replace(/'/g, "\\'")}', asOf: '${m.asOf}' },`,
        )
        .join('\n')
      return `  '${id}': [\n${rows}\n  ],`
    })
    .join('\n')
  const mapRows = maps
    .map(
      (m) =>
        `  { from: '${m.from}', to: '${m.to}', a: ${String(m.a)}, b: ${String(m.b)}, anchorCount: ${String(m.anchorCount)}, anchorMin: ${String(m.anchorMin)}, anchorMax: ${String(m.anchorMax)}, fittedAsOf: '${m.fittedAsOf}' },`,
    )
    .join('\n')
  const aliasRows = data.scores
    .flatMap((m) => (m.aliases ?? []).map((alias) => [alias, m.modelId] as const))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([alias, id]) => `  '${alias.replace(/'/g, "\\'")}': '${id}',`)
    .join('\n')
  return `// AUTO-GENERATED by scripts/sync-intellect.mts. Do not edit by hand.
// Intelligence-index measurements (cloud + local model ids) and crystallised
// cross-version equating maps. Source of truth: scripts/data/intellect-scores.json.
// Absent models mean "no sourced measurement yet", not zero.
// ${data.attribution}
// Last synced: ${today}

import type { EquatingMap } from './intellect-equating.ts'

export interface IntellectMeasurement {
  value: number
  indexVersion: string
  source: string
  asOf: string
}

/** The permanent display/comparison scale. Changing it is a breaking re-baseline. */
export const CANONICAL_INTELLECT_VERSION = '${data.canonicalVersion}'

export const INTELLECT_ATTRIBUTION = '${data.attribution.replace(/'/g, "\\'")}'

export const MODEL_INTELLECT_RAW: Record<string, IntellectMeasurement[]> = {
${body}
}

/** Alternate id/label forms (OpenRouter ids, ACP labels) → catalog model id. */
export const INTELLECT_ALIASES: Record<string, string> = {
${aliasRows}
}

export const INTELLECT_EQUATING_MAPS: readonly EquatingMap[] = [
${mapRows}
]
`
}

interface AaApiModel {
  id?: string
  slug?: string
  name?: string
  evaluations?: { artificial_analysis_intelligence_index?: number }
}

/**
 * Refresh measurements from the Artificial Analysis API for models the seed
 * file already knows (by modelId or alias). Returns the updated score list;
 * never invents a new model id. Each refreshed entry cites the API and the
 * operator-pinned index version.
 */
async function refreshFromApi(
  data: DataFile,
  indexVersion: string,
  apiKey: string,
  today: string,
): Promise<Measurement[]> {
  const res = await fetch('https://artificialanalysis.ai/api/v2/data/llms/models', {
    headers: { 'x-api-key': apiKey },
  })
  if (!res.ok) fail(`Artificial Analysis API → ${String(res.status)} ${res.statusText}`)
  const payload = (await res.json()) as { data?: AaApiModel[] }
  const apiModels = payload.data ?? []

  const aliasToId = new Map<string, string>()
  for (const m of data.scores) {
    aliasToId.set(m.modelId, m.modelId)
    for (const alias of m.aliases ?? []) aliasToId.set(alias, m.modelId)
  }

  const next = [...data.scores]
  let refreshed = 0
  for (const api of apiModels) {
    const value = api.evaluations?.artificial_analysis_intelligence_index
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const modelId = [api.id, api.slug, api.name]
      .map((k) => (k ? aliasToId.get(k) : undefined))
      .find((id) => id !== undefined)
    if (!modelId) continue
    const aliases = next.find((m) => m.modelId === modelId)?.aliases
    const measurement: Measurement = {
      modelId,
      value,
      indexVersion,
      source: `Artificial Analysis API (index ${indexVersion} pinned by operator), model '${api.slug ?? api.name ?? api.id ?? ''}', fetched ${today}`,
      asOf: today,
      ...(aliases ? { aliases } : {}),
    }
    const existing = next.findIndex((m) => m.modelId === modelId && m.indexVersion === indexVersion)
    if (existing >= 0) next[existing] = { ...next[existing], ...measurement }
    else next.push(measurement)
    refreshed += 1
  }
  console.log(
    `[sync-intellect] API refresh: ${String(refreshed)} measurement(s) matched known models ` +
      `(${String(apiModels.length)} models in the API feed; unmatched models are ignored by design).`,
  )
  return next
}

async function main(): Promise<void> {
  const refit = process.argv.includes('--refit')
  const fromApi = process.argv.includes('--from-api')
  const versionArg = process.argv.find((a) => a.startsWith('--index-version='))
  const today = new Date().toISOString().slice(0, 10)
  const raw = await readFile(DATA_PATH, 'utf8')
  let data = JSON.parse(raw) as DataFile
  validate(data)

  if (fromApi) {
    const apiKey = process.env['ARTIFICIAL_ANALYSIS_API_KEY']
    if (!apiKey) fail('--from-api requires ARTIFICIAL_ANALYSIS_API_KEY')
    const indexVersion = versionArg?.slice('--index-version='.length)
    if (!indexVersion) {
      fail('--from-api requires --index-version=<vX.Y> (the API does not name its index version)')
    }
    const scores = await refreshFromApi(data, indexVersion, apiKey, today)
    data = { ...data, scores }
    validate(data)
    await writeFile(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  }

  const maps = resolveEquating(data, today, refit)

  // Crystallise any newly-fitted maps back into the reviewed data file.
  const storedJson = JSON.stringify(data.equating)
  const nextJson = JSON.stringify(maps)
  if (storedJson !== nextJson) {
    const updated: DataFile = { ...data, equating: maps }
    await writeFile(DATA_PATH, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
    console.log(
      `[sync-intellect] Crystallised ${String(maps.length)} equating fit(s) into ${DATA_PATH}.`,
    )
  }

  const content = renderFile(data, maps, today)
  const existing = await readFile(GENERATED_PATH, 'utf8').catch(() => '')
  const stripSyncDate = (s: string): string =>
    s.replace(/\/\/ Last synced: \d{4}-\d{2}-\d{2}\n/, '')
  if (stripSyncDate(existing) === stripSyncDate(content)) {
    console.log(`[sync-intellect] No changes (${String(data.scores.length)} measurements).`)
    return
  }
  await writeFile(GENERATED_PATH, content, 'utf8')
  execFileSync('npx', ['prettier', '--write', GENERATED_PATH], { stdio: 'inherit' })
  console.log(
    `[sync-intellect] Wrote ${String(data.scores.length)} measurement(s), ` +
      `${String(maps.length)} equating map(s) to ${GENERATED_PATH} (synced ${today}).`,
  )
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
