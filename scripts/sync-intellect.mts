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
//   ARTIFICIAL_ANALYSIS_API_KEY=... npm run sync:intellect -- --from-api
// Fetches Artificial Analysis' model list from the supported free-tier language
// feed (`/api/v2/language/models/free` — the documented replacement for the
// legacy `/api/v2/data/llms/models`, which returns 410 Gone after 2026-11-04)
// and refreshes/adds measurements for models we support: those already in
// `scores`, PLUS the `wanted` allowlist of catalog models we don't have a value
// for yet (local models, extra tracked cloud models). Every page of the feed is
// walked. Matched by id or alias — the API never introduces a model id
// that isn't scored or wanted, so every plotted model remains a reviewed
// decision, and nobody hand-enters a mis-configured number. The index version
// is read from the payload's declared version field when present, else defaults
// to the data file's canonicalVersion (the AA API always reports the current
// index, so "the latest" is canonical) with a warning; pass --index-version=
// <vX.Y> to override, e.g. after AA renormalises. Attribution is required by
// AA's free tier and is carried in the JSON + generated output.

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { writeGeneratedFile } from './lib/generated-file.mts'
import {
  MIN_RECOMMENDED_ANCHORS,
  fitLinearEquating,
  type AnchorPair,
  type EquatingMap,
} from '../packages/llm/src/intellect-equating.ts'
import { optionalRecord } from '../src/shared/unknown-value.mts'

const DATA_PATH = resolve('scripts/data/intellect-scores.json')
const GENERATED_PATH = resolve('packages/llm/src/model-intellect.generated.ts')
/** Supported free-tier feed; see {@link requestAaModels} for the migration note. */
const AA_MODELS_URL = 'https://artificialanalysis.ai/api/v2/language/models/free'

export interface Measurement {
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
  aliases?: string[] | undefined
}

/**
 * A model we support (in a catalog) and want AA data for, but don't have a
 * value for yet. `--from-api` matches these by id/alias against the feed and
 * ADDS a measurement — so "get data for the models we support" is one keyed
 * sync, with no hand-entered (and easily mis-configured) numbers.
 */
export interface WantedModel {
  modelId: string
  aliases?: string[] | undefined
}

export interface DataFile {
  canonicalVersion: string
  attribution: string
  scores: Measurement[]
  /** Catalog models to populate from the API when it carries them. */
  wanted?: WantedModel[] | undefined
  /** Version hops we intend to fit, e.g. { "from": "v4.2", "to": "v4.1" }. */
  equatingPairs: Array<{ from: string; to: string }>
  /** Crystallised fits — written back by this script, reused on later runs. */
  equating: EquatingMap[]
}

const measurementSchema: z.ZodType<Measurement> = z.object({
  modelId: z.string(),
  value: z.number(),
  indexVersion: z.string(),
  source: z.string(),
  asOf: z.string(),
  aliases: z.array(z.string()).optional(),
})
const wantedModelSchema: z.ZodType<WantedModel> = z.object({
  modelId: z.string(),
  aliases: z.array(z.string()).optional(),
})
const equatingMapSchema: z.ZodType<EquatingMap> = z.object({
  from: z.string(),
  to: z.string(),
  a: z.number(),
  b: z.number(),
  anchorCount: z.number(),
  anchorMin: z.number(),
  anchorMax: z.number(),
  fittedAsOf: z.string(),
})
const dataFileSchema: z.ZodType<DataFile> = z.object({
  canonicalVersion: z.string(),
  attribution: z.string(),
  scores: z.array(measurementSchema),
  wanted: z.array(wantedModelSchema).optional(),
  equatingPairs: z.array(z.object({ from: z.string(), to: z.string() })),
  equating: z.array(equatingMapSchema),
})
// `nullish`, not `optional`: the supported free feed represents "not measured"
// as an explicit null (both for individual fields and for whole rows in `data`),
// which `optional()` alone rejects.
const aaApiModelSchema: z.ZodType<AaApiModel> = z.object({
  id: z.string().nullish(),
  slug: z.string().nullish(),
  name: z.string().nullish(),
  evaluations: z
    .object({
      artificial_analysis_intelligence_index: z.number().nullish(),
      artificial_analysis_intelligence_index_version: z.union([z.string(), z.number()]).nullish(),
    })
    .nullish(),
})
const aaPayloadSchema = z
  .object({
    data: z.array(aaApiModelSchema.nullable()).nullish(),
    pagination: z
      .object({
        page: z.number().optional(),
        total_pages: z.number().optional(),
        has_more: z.boolean().optional(),
      })
      .nullish(),
  })
  .loose()

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
  // A wanted model must not already have a measurement (it belongs in scores
  // then), and its aliases must not collide with another model's.
  const scoredIds = new Set(data.scores.map((m) => m.modelId))
  for (const w of data.wanted ?? []) {
    if (!w.modelId) fail('wanted entry missing modelId')
    if (scoredIds.has(w.modelId)) {
      fail(`wanted model '${w.modelId}' already has a measurement — remove it from wanted`)
    }
    for (const alias of w.aliases ?? []) {
      if (alias === w.modelId) fail(`wanted alias '${alias}' duplicates its own modelId`)
      const owner = aliasOwner.get(alias)
      if (owner !== undefined && owner !== w.modelId) {
        fail(`alias '${alias}' claimed by both '${owner}' and wanted '${w.modelId}'`)
      }
      aliasOwner.set(alias, w.modelId)
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
  // A model with several measurements (e.g. a v4.0 and a v4.1 reading) repeats
  // its aliases on every score row; collapse to one entry per alias so the
  // emitted object literal has no duplicate keys.
  const aliasById = new Map<string, string>()
  for (const m of data.scores) {
    for (const alias of m.aliases ?? []) {
      if (!aliasById.has(alias)) aliasById.set(alias, m.modelId)
    }
  }
  const aliasRows = [...aliasById.entries()]
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

export interface AaApiModel {
  id?: string | null | undefined
  slug?: string | null | undefined
  name?: string | null | undefined
  evaluations?:
    | {
        artificial_analysis_intelligence_index?: number | null | undefined
        artificial_analysis_intelligence_index_version?: string | number | null | undefined
      }
    | null
    | undefined
}

/** Normalise the API's version form ("4.1", 4.1) to our labels ("v4.1"). */
function normalizeVersion(v: string | number | undefined): string | undefined {
  if (v === undefined) return undefined
  const s = String(v).trim()
  if (!s) return undefined
  return s.startsWith('v') ? s : `v${s}`
}

/**
 * The index version the payload declares, checked against the field spellings
 * AA might use at the payload, metadata, or per-model level. Undefined when
 * none match (the caller then defaults to the canonical version).
 */
export function detectPayloadVersion(
  payload: Record<string, unknown>,
  apiModels: readonly AaApiModel[],
): string | undefined {
  const meta = optionalRecord(payload['metadata'])
  const candidates: Array<unknown> = [
    payload['artificial_analysis_intelligence_index_version'],
    payload['intelligence_index_version'],
    payload['intelligence_index_version_number'],
    payload['index_version'],
    payload['version'],
    meta?.['artificial_analysis_intelligence_index_version'],
    meta?.['intelligence_index_version'],
    meta?.['index_version'],
    meta?.['version'],
    apiModels.find((m) => m.evaluations?.artificial_analysis_intelligence_index_version)
      ?.evaluations?.artificial_analysis_intelligence_index_version,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' || typeof c === 'number') {
      const v = normalizeVersion(c)
      if (v) return v
    }
  }
  return undefined
}

/**
 * Fetch every page of the supported free-tier language feed.
 *
 * This is the documented replacement for the retired `/api/v2/data/llms/models`
 * — AA's migration guide maps the legacy path onto exactly this URL, legacy
 * paths return 410 Gone after 2026-11-04 23:59 UTC, and the key is unchanged.
 * Unlike the legacy feed it paginates (200 rows a page), so walk `pagination`
 * until it says there is nothing more; the first page is returned alongside the
 * rows because that is where the declared index version lives.
 * See https://artificialanalysis.ai/data-api/migrate-v2-data.
 */
export async function requestAaModels(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ firstPayload: Record<string, unknown>; models: AaApiModel[] }> {
  const models: AaApiModel[] = []
  let firstPayload: Record<string, unknown> = {}
  let page = 1
  let hasMore = true
  while (hasMore) {
    const url = new URL(AA_MODELS_URL)
    url.searchParams.set('page', String(page))
    const res = await fetchImpl(url, { headers: { 'x-api-key': apiKey } })
    if (!res.ok) {
      // 410 is AA's marker for a retired `/api/v2/data/*` path. We no longer
      // request one, so it would mean the supported endpoint itself moved.
      const hint = res.status === 410 ? ' (endpoint retired — AA_MODELS_URL needs updating)' : ''
      fail(`Artificial Analysis API → ${String(res.status)} ${res.statusText}${hint}`)
    }
    const payload = aaPayloadSchema.parse((await res.json()) as unknown)
    if (page === 1) firstPayload = payload
    models.push(...(payload.data ?? []).filter((m): m is AaApiModel => m !== null))

    const pagination = payload.pagination
    hasMore =
      pagination?.has_more === true ||
      (typeof pagination?.total_pages === 'number' && page < pagination.total_pages)
    if (hasMore) page += 1
  }
  return { firstPayload, models }
}

/**
 * Refresh measurements from the Artificial Analysis API for models the seed
 * file already knows (by modelId or alias). Returns the updated score list;
 * never invents a new model id. The index version comes from the payload's own
 * version field; a `--index-version=` pin, when passed, must agree with it
 * (and covers a payload that omits the field).
 */
async function refreshFromApi(
  data: DataFile,
  pinnedVersion: string | undefined,
  apiKey: string,
  today: string,
): Promise<Measurement[]> {
  const { firstPayload, models: apiModels } = await requestAaModels(apiKey)
  const declared = detectPayloadVersion(firstPayload, apiModels)
  const pinned = normalizeVersion(pinnedVersion)
  if (declared && pinned && declared !== pinned) {
    fail(`--index-version=${pinned} conflicts with the payload's declared index ${declared}`)
  }
  // Default to the data file's canonical version: the AA API always reports the
  // CURRENT index, and canonicalVersion is our tracking of it — so with no
  // declared field and no pin, "the latest" is canonical. Loud about the
  // assumption; --index-version overrides, and the live panel's anchor gate is
  // the display-time safety net if AA has since renormalised.
  const canonical = normalizeVersion(data.canonicalVersion)
  const indexVersion = declared ?? pinned ?? canonical
  if (!indexVersion) fail('no index version declared, pinned, or set as canonicalVersion')
  if (!declared && !pinned) {
    console.warn(
      `[sync-intellect] WARNING: the feed declared no index version; assuming the canonical ` +
        `${indexVersion}. If Artificial Analysis has renormalised its index, pass ` +
        `--index-version=<vX.Y> instead.`,
    )
  }

  const merged = mergeApiModels(data, apiModels, indexVersion, today)
  console.log(
    `[sync-intellect] API refresh: ${String(merged.matched)} measurement(s) matched supported ` +
      `models (${String(apiModels.length)} in the feed; unmatched models are ignored by design).`,
  )
  return merged.scores
}

/**
 * Pure merge of an API model list into the seed's measurements. A feed model is
 * matched (by id/slug/name) against known measurements AND the `wanted`
 * allowlist of catalog models; a match refreshes an existing same-version entry
 * or adds a new one. Never introduces a model id that isn't already known or
 * wanted. Deterministic — no I/O, no clock (today is passed in).
 */
export function mergeApiModels(
  data: DataFile,
  apiModels: readonly AaApiModel[],
  indexVersion: string,
  today: string,
): { scores: Measurement[]; matched: number } {
  const aliasToId = new Map<string, string>()
  const aliasesFor = new Map<string, string[]>()
  const learn = (modelId: string, aliases: string[] | undefined): void => {
    aliasToId.set(modelId, modelId)
    // A self-referential alias is not a valid alias (validate() rejects it);
    // strip defensively so a carried alias set can't reintroduce one.
    const clean = (aliases ?? []).filter((a) => a !== modelId)
    for (const alias of clean) aliasToId.set(alias, modelId)
    if (clean.length > 0) aliasesFor.set(modelId, clean)
  }
  for (const m of data.scores) learn(m.modelId, m.aliases)
  for (const w of data.wanted ?? []) learn(w.modelId, w.aliases)

  const next = [...data.scores]
  let matched = 0
  for (const api of apiModels) {
    const value = api.evaluations?.artificial_analysis_intelligence_index
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const modelId = [api.id, api.slug, api.name]
      .map((k) => (k ? aliasToId.get(k) : undefined))
      .find((id) => id !== undefined)
    if (!modelId) continue
    const aliases = aliasesFor.get(modelId)
    const measurement: Measurement = {
      modelId,
      value,
      indexVersion,
      source: `Artificial Analysis API (index ${indexVersion}), model '${api.slug ?? api.name ?? api.id ?? ''}', fetched ${today}`,
      asOf: today,
      ...(aliases ? { aliases } : {}),
    }
    const existing = next.findIndex((m) => m.modelId === modelId && m.indexVersion === indexVersion)
    if (existing >= 0) next[existing] = { ...next[existing], ...measurement }
    else next.push(measurement)
    matched += 1
  }
  return { scores: next, matched }
}

/** Drop `wanted` entries that now have a measurement in `scores`. */
export function graduateWanted(
  wanted: readonly WantedModel[],
  scores: readonly Measurement[],
): WantedModel[] {
  const scoredIds = new Set(scores.map((m) => m.modelId))
  return wanted.filter((w) => !scoredIds.has(w.modelId))
}

async function main(): Promise<void> {
  const refit = process.argv.includes('--refit')
  const fromApi = process.argv.includes('--from-api')
  const versionArg = process.argv.find((a) => a.startsWith('--index-version='))
  const today = new Date().toISOString().slice(0, 10)
  const raw = await readFile(DATA_PATH, 'utf8')
  let data = dataFileSchema.parse(JSON.parse(raw) as unknown)
  validate(data)

  if (fromApi) {
    const apiKey = process.env['ARTIFICIAL_ANALYSIS_API_KEY']
    if (!apiKey) fail('--from-api requires ARTIFICIAL_ANALYSIS_API_KEY')
    const pinned = versionArg?.slice('--index-version='.length)
    const scores = await refreshFromApi(data, pinned, apiKey, today)
    // A wanted model the API just populated has graduated into `scores`, so
    // drop it from the allowlist — otherwise it lives in both lists and
    // validate() (rightly) rejects the overlap.
    const wanted = graduateWanted(data.wanted ?? [], scores)
    data = { ...data, scores, wanted }
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
  if (!(await writeGeneratedFile(GENERATED_PATH, content))) {
    console.log(`[sync-intellect] No changes (${String(data.scores.length)} measurements).`)
    return
  }
  console.log(
    `[sync-intellect] Wrote ${String(data.scores.length)} measurement(s), ` +
      `${String(maps.length)} equating map(s) to ${GENERATED_PATH} (synced ${today}).`,
  )
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
