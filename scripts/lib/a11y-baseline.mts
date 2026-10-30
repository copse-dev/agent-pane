import { z } from 'zod'

/**
 * Known axe-core violations the accessibility lane tolerates, per scanned
 * surface and rule (docs/accessibility.md). The e2e spec requires the observed
 * counts to equal this file exactly, so a fix must shrink it in the same PR;
 * `check:a11y-baseline` refuses any growth relative to the base ref.
 */
export const A11Y_BASELINE_PATH = 'tests/e2e/accessibility-baseline.json'

const trackerSchema = z
  .url()
  .regex(/^https:\/\/github\.com\/copse-dev\/agent-pane\/issues\/[1-9]\d*$/)

export const a11yBaselineSchema = z.strictObject({
  version: z.literal(1),
  surfaces: z.record(
    z.string().regex(/^[a-z0-9-]+$/),
    z.record(
      z.string().regex(/^[a-z0-9-]+$/),
      z.strictObject({ count: z.int().positive(), tracker: trackerSchema }),
    ),
  ),
})

export type A11yBaseline = z.infer<typeof a11yBaselineSchema>

/** Violating node count per axe rule id for one surface. */
export type RuleCounts = Readonly<Record<string, number>>

export interface BaselineMismatch {
  rule: string
  observed: number
  allowed: number
}

export interface SurfaceComparison {
  /** Rules with more violating nodes than the baseline allows: new regressions. */
  added: BaselineMismatch[]
  /** Rules with fewer violating nodes than recorded: the baseline must shrink. */
  stale: BaselineMismatch[]
}

function allowedCounts(baseline: A11yBaseline, surface: string): Map<string, number> {
  const rules = Object.hasOwn(baseline.surfaces, surface) ? baseline.surfaces[surface] : undefined
  return new Map(Object.entries(rules ?? {}).map(([rule, entry]) => [rule, entry.count]))
}

/** Compare one surface's observed violations with its recorded baseline. */
export function compareSurface(
  baseline: A11yBaseline,
  surface: string,
  observed: RuleCounts,
): SurfaceComparison {
  const allowed = allowedCounts(baseline, surface)
  const rules = [...new Set([...allowed.keys(), ...Object.keys(observed)])].sort()
  const added: BaselineMismatch[] = []
  const stale: BaselineMismatch[] = []
  for (const rule of rules) {
    const seen = Object.hasOwn(observed, rule) ? (observed[rule] ?? 0) : 0
    const limit = allowed.get(rule) ?? 0
    if (seen > limit) added.push({ rule, observed: seen, allowed: limit })
    else if (seen < limit) stale.push({ rule, observed: seen, allowed: limit })
  }
  return { added, stale }
}

/**
 * Every way `head` tolerates more than `base`: a new surface/rule entry or a
 * higher count. Removing entries and lowering counts is always allowed, and so
 * is re-pointing a tracker.
 */
export function baselineGrowth(base: A11yBaseline, head: A11yBaseline): string[] {
  const problems: string[] = []
  for (const [surface, rules] of Object.entries(head.surfaces)) {
    const before = allowedCounts(base, surface)
    for (const [rule, entry] of Object.entries(rules)) {
      const limit = before.get(rule)
      if (limit === undefined) {
        problems.push(`${surface}/${rule}: new baseline entry (${String(entry.count)})`)
      } else if (entry.count > limit) {
        problems.push(`${surface}/${rule}: grew from ${String(limit)} to ${String(entry.count)}`)
      }
    }
  }
  return problems
}

/** Stable, formatter-compatible JSON for a baseline (sorted surfaces and rules). */
export function formatA11yBaseline(baseline: A11yBaseline): string {
  const surfaces = Object.fromEntries(
    Object.entries(baseline.surfaces)
      .filter(([, rules]) => Object.keys(rules).length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([surface, rules]) => [
        surface,
        Object.fromEntries(Object.entries(rules).sort(([a], [b]) => a.localeCompare(b))),
      ]),
  )
  return `${JSON.stringify({ version: baseline.version, surfaces }, null, 2)}\n`
}
