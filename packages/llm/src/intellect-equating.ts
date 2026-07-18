// Cross-version equating for intelligence-index scores (psychometric test
// linking). Index versions renormalise — v4 swapped in harder evals than v3 and
// every model's number changed — so raw values are only comparable within one
// version. We pin a *canonical* version as the permanent ruler and translate
// scores from other versions onto it using models measured under both versions
// ("anchors"), so previously-recorded canonical scores never move: a new model
// scored on a newer, harder suite is mapped backwards and must genuinely clear
// the old bar to outrank an old model.
//
// Stability rules (see docs/plans/model-roles-and-defaults.md):
//   - Measured canonical values are immutable facts.
//   - Fitted maps are crystallised into the sync data at first fit; re-syncing
//     reuses the stored map, so adding anchors later never silently shifts a
//     previously-equated value. Refitting is an explicit, reviewed event.
//   - An equated value is an ESTIMATE and is always flagged as one, with the
//     hop(s) and fit quality in its basis string. Values above the anchor range
//     are additionally marked extrapolated — ceiling compression makes
//     top-of-scale translation the least reliable, exactly where frontier
//     models sit.

/** A fitted linear map translating scores from one index version to another. */
export interface EquatingMap {
  /** Index version the input value was measured on. */
  from: string
  /** Index version the output value is expressed on. */
  to: string
  /** value_to = a * value_from + b */
  a: number
  b: number
  /** Number of anchor models the fit used. */
  anchorCount: number
  /** Anchor input range; outputs from inputs outside it are extrapolations. */
  anchorMin: number
  anchorMax: number
  /** ISO date the fit was crystallised. */
  fittedAsOf: string
}

/** One model measured under both versions of a hop. */
export interface AnchorPair {
  fromValue: number
  toValue: number
}

/** Below this anchor count a fit is statistically shaky; sync warns loudly. */
export const MIN_RECOMMENDED_ANCHORS = 5

/**
 * Least-squares linear fit over anchor pairs. Requires ≥2 pairs with distinct
 * `fromValue`s (a slope needs spread). Deliberately linear-only for v1 — a
 * monotone piecewise fit can replace it behind the same interface once there
 * are enough anchors to justify it.
 */
export function fitLinearEquating(
  from: string,
  to: string,
  pairs: readonly AnchorPair[],
  fittedAsOf: string,
): EquatingMap {
  if (pairs.length < 2) {
    throw new Error(`equating ${from}→${to}: need ≥2 anchor pairs, got ${String(pairs.length)}`)
  }
  const n = pairs.length
  const meanX = pairs.reduce((s, p) => s + p.fromValue, 0) / n
  const meanY = pairs.reduce((s, p) => s + p.toValue, 0) / n
  let sxx = 0
  let sxy = 0
  for (const p of pairs) {
    sxx += (p.fromValue - meanX) * (p.fromValue - meanX)
    sxy += (p.fromValue - meanX) * (p.toValue - meanY)
  }
  if (sxx === 0) {
    throw new Error(`equating ${from}→${to}: anchor inputs are all identical; cannot fit a slope`)
  }
  const a = sxy / sxx
  const b = meanY - a * meanX
  return {
    from,
    to,
    a,
    b,
    anchorCount: n,
    anchorMin: Math.min(...pairs.map((p) => p.fromValue)),
    anchorMax: Math.max(...pairs.map((p) => p.fromValue)),
    fittedAsOf,
  }
}

export interface EquatedValue {
  value: number
  /** True when any hop's input fell outside that hop's anchor range. */
  extrapolated: boolean
  /** Hops applied, in order — for the basis/provenance string. */
  hops: readonly EquatingMap[]
}

/**
 * Translate `value` from `fromVersion` to `toVersion` by chaining the stored
 * maps (shortest path; maps are directional). Returns null when no path exists.
 * Hops compound error, so callers should surface `hops.length` in provenance.
 */
export function equateAcrossVersions(
  value: number,
  fromVersion: string,
  toVersion: string,
  maps: readonly EquatingMap[],
): EquatedValue | null {
  if (fromVersion === toVersion) return { value, extrapolated: false, hops: [] }
  // Breadth-first over version nodes; map count is tiny, clarity over speed.
  const queue: Array<{ version: string; path: EquatingMap[] }> = [
    { version: fromVersion, path: [] },
  ]
  const visited = new Set<string>([fromVersion])
  while (queue.length > 0) {
    const { version, path } = queue.shift() as { version: string; path: EquatingMap[] }
    for (const map of maps) {
      if (map.from !== version || visited.has(map.to)) continue
      const next = [...path, map]
      if (map.to === toVersion) {
        let v = value
        let extrapolated = false
        for (const hop of next) {
          if (v < hop.anchorMin || v > hop.anchorMax) extrapolated = true
          v = hop.a * v + hop.b
        }
        return { value: Number(v.toFixed(1)), extrapolated, hops: next }
      }
      visited.add(map.to)
      queue.push({ version: map.to, path: next })
    }
  }
  return null
}

/** Human-readable provenance for an equated value, for `basis` strings. */
export function describeEquating(equated: EquatedValue): string {
  const route = equated.hops.map((h) => `${h.from}→${h.to}`).join(', ')
  const anchors = equated.hops.map((h) => String(h.anchorCount)).join('+')
  const extra = equated.extrapolated ? '; extrapolated beyond anchor range' : ''
  return `equated ${route} (linear fit, ${anchors} anchors${extra})`
}
