// The anchor gate for LIVE Artificial Analysis data. The AA API reports
// current-index values without naming the index version, and the index
// renormalises (v4.0 read Opus 4.8 at 61; v4.1 reads the same checkpoint at
// 56) — so live values may or may not be on our canonical scale, and plotting
// a wrong-scale value would silently corrupt every comparison.
//
// The gate exploits what we do hold: curated canonical measurements. If the
// live feed agrees with our canonical anchors (within tolerance), the feed IS
// the canonical cohort and models we never curated can safely join the graph —
// always flagged as estimates whose basis names the verification. If any
// anchor diverges, AA has renormalised: callers must refuse to mix and fall
// back to curated data (and a human re-pins the version via
// `sync:intellect --from-api --index-version=...`, gaining a fresh set of
// equating anchors in the process).
//
// Everything here is pure — fetching, key handling, and caching live in the
// main process; this module only decides what the data means.

import { CANONICAL_INTELLECT_VERSION, MODEL_INTELLECT_RAW } from './model-intellect.generated.ts'
import { getIntellectScore, resolveIntellectModelId } from './model-intellect.ts'
import { blendedRate, type FrontierCandidate } from './pareto-frontier.ts'

/**
 * Max |live − canonical| per anchor before the feed is declared a different
 * cohort. AA republishes with small eval-rerun jitter; a renormalisation moves
 * anchors by whole points (the v4.0→v4.1 shift was 5).
 */
export const LIVE_ANCHOR_TOLERANCE = 1

/** Fewer verified anchors than this and the cohort cannot be trusted. */
export const MIN_LIVE_ANCHORS = 2

/**
 * The most diverging anchors the gate tolerates, as a fraction of those
 * checked. A whole-index renormalisation moves EVERY anchor by whole points at
 * once (v4.0→v4.1 shifted them all by ~5), so it shows up as a majority — far
 * over this bar — and is still refused. A lone outlier, by contrast, is almost
 * always one stale curated anchor (e.g. a value we sourced from a chart or a
 * model page rather than the API), and must not veto an otherwise-canonical
 * feed. Below this fraction the feed is trusted and the outliers are reported
 * as stale rather than treated as a scale shift.
 */
export const MAX_MISMATCH_FRACTION = 0.25

/** One model row from the live AA feed, already reduced to what we consume. */
export interface LiveAaModel {
  /** AA's identifier for the model (slug or name) — shown as-is when uncurated. */
  id: string
  intellect: number
  /** AA-reported USD per MTok, when present — the cost axis for uncurated models. */
  inputPricePerMTok?: number
  outputPricePerMTok?: number
  /** AA's own cost per Intelligence Index task in USD, when the feed carries it. */
  costPerTask?: number
}

export interface LiveCohortVerification {
  /** True when the scale is confirmed canonical: enough anchors agree and the
   * diverging ones are a minority (see {@link MAX_MISMATCH_FRACTION}). */
  verified: boolean
  anchorsChecked: number
  /** Anchors within tolerance — the agreeing majority a verified feed needs. */
  agreeingAnchors: number
  maxDrift: number
  /** Anchors that diverged beyond tolerance (empty when verified). */
  mismatches: Array<{ modelId: string; canonical: number; live: number }>
  /** The index version the feed declared, normalised (e.g. "v4.1"), if any. */
  reportedVersion?: string
  /** Set when the feed declared a version other than the canonical one. */
  versionMismatch?: boolean
}

/** Canonical, directly-measured values (never equated) — the anchor set. */
function canonicalAnchors(): Map<string, number> {
  const out = new Map<string, number>()
  for (const [modelId, entries] of Object.entries(MODEL_INTELLECT_RAW)) {
    const canonical = entries.find((m) => m.indexVersion === CANONICAL_INTELLECT_VERSION)
    if (canonical) out.set(modelId, canonical.value)
  }
  return out
}

/** Normalise the API's version form ("4.1", 4.1) to our labels ("v4.1"). */
export function normalizeIndexVersion(version: string | number | undefined): string | undefined {
  if (version === undefined) return undefined
  const s = String(version).trim()
  if (s.length === 0) return undefined
  return s.startsWith('v') ? s : `v${s}`
}

/**
 * Decide whether a live feed is on the canonical scale. The AA API declares
 * the index version its scores belong to — when present, it must equal the
 * canonical version. Anchor comparison against curated canonical measurements
 * runs as defense-in-depth either way (and carries the decision alone for a
 * feed that omits the version): fewer than {@link MIN_LIVE_ANCHORS} matched
 * anchors, or any divergence, is a refusal — an unknown scale never passes.
 */
export function verifyLiveCohort(
  liveModels: readonly LiveAaModel[],
  reportedVersion?: string | number,
): LiveCohortVerification {
  const anchors = canonicalAnchors()
  let anchorsChecked = 0
  let maxDrift = 0
  const mismatches: LiveCohortVerification['mismatches'] = []
  for (const live of liveModels) {
    const modelId = resolveIntellectModelId(live.id)
    if (modelId === null) continue
    const canonical = anchors.get(modelId)
    if (canonical === undefined) continue
    anchorsChecked += 1
    const drift = Math.abs(live.intellect - canonical)
    maxDrift = Math.max(maxDrift, drift)
    if (drift > LIVE_ANCHOR_TOLERANCE) mismatches.push({ modelId, canonical, live: live.intellect })
  }
  const version = normalizeIndexVersion(reportedVersion)
  const versionMismatch = version !== undefined && version !== CANONICAL_INTELLECT_VERSION
  // Trust the feed when enough anchors AGREE and the diverging ones are a
  // minority (stale individual values, not a renormalised scale). `agreeing`,
  // not the raw total, must clear MIN_LIVE_ANCHORS so a feed that resolves few
  // anchors and disagrees on them never passes.
  const agreeingAnchors = anchorsChecked - mismatches.length
  const mismatchesAreAMinority =
    mismatches.length <= Math.floor(anchorsChecked * MAX_MISMATCH_FRACTION)
  return {
    verified:
      !versionMismatch && agreeingAnchors >= MIN_LIVE_ANCHORS && mismatchesAreAMinority,
    anchorsChecked,
    agreeingAnchors,
    maxDrift,
    mismatches,
    ...(version !== undefined ? { reportedVersion: version } : {}),
    ...(versionMismatch ? { versionMismatch: true } : {}),
  }
}

export interface LiveIntellectResult {
  /** Uncurated models with both a live score and live pricing — plottable. */
  candidates: FrontierCandidate[]
  /** Uncurated models with a live score but no pricing — picker-hint material. */
  hintOnly: Array<{ id: string; intellect: number }>
  /**
   * Curated models the feed carries PRICING for: the reviewed measurement
   * stays the score (curated wins), the feed contributes the missing price —
   * one plottable point instead of a gutter entry plus a live duplicate.
   * Callers must still skip ids they already price from another source.
   */
  pricedCurated: FrontierCandidate[]
  verification: LiveCohortVerification
}

/**
 * The feed's blended price for a model, or null when it carries no usable
 * price. A real inference price is strictly positive; the AA free tier reports
 * many models with a zero/absent price, and accepting those as "$0" would pile
 * hundreds of models onto the free axis where all but one are dominated. Such
 * models are unpriced, not free — only genuine on-device models are free.
 */
function liveBlendedPrice(live: LiveAaModel): number | null {
  const input = live.inputPricePerMTok
  if (typeof input !== 'number' || !(input > 0)) return null
  const output = live.outputPricePerMTok
  return blendedRate(input, typeof output === 'number' && output > 0 ? output : input)
}

/**
 * Frontier candidates for live models that are NOT already curated (curated
 * measurements always win — the reviewed number is never displaced by a feed).
 * Returns no candidates at all when the cohort fails verification: wrong-scale
 * data must never reach an axis. Every candidate is an estimate by definition.
 */
export function liveIntellectCandidates(
  liveModels: readonly LiveAaModel[],
  reportedVersion?: string | number,
): LiveIntellectResult {
  const verification = verifyLiveCohort(liveModels, reportedVersion)
  if (!verification.verified) {
    return { candidates: [], hintOnly: [], pricedCurated: [], verification }
  }
  const candidates: FrontierCandidate[] = []
  const hintOnly: Array<{ id: string; intellect: number }> = []
  const pricedCurated: FrontierCandidate[] = []
  const curatedSeen = new Set<string>()
  for (const live of liveModels) {
    const price = liveBlendedPrice(live)
    const resolved = resolveIntellectModelId(live.id)
    if (resolved !== null) {
      // Curated model: the reviewed measurement is the score; the feed may
      // still contribute the missing price coordinate.
      if (price === null || curatedSeen.has(resolved)) continue
      const curated = getIntellectScore(resolved)
      if (!curated) continue
      curatedSeen.add(resolved)
      pricedCurated.push({
        id: resolved,
        intellect: curated.value,
        intellectEstimated: curated.estimated === true,
        costPerMTok: price,
        ...(typeof live.costPerTask === 'number' ? { costPerTask: live.costPerTask } : {}),
      })
      continue
    }
    if (price !== null) {
      candidates.push({
        id: live.id,
        intellect: live.intellect,
        intellectEstimated: true,
        costPerMTok: price,
        // Uncurated = the user can't route to it without setting up a provider.
        discovery: true,
        ...(typeof live.costPerTask === 'number' ? { costPerTask: live.costPerTask } : {}),
      })
    } else {
      hintOnly.push({ id: live.id, intellect: live.intellect })
    }
  }
  return { candidates, hintOnly, pricedCurated, verification }
}
