// Scale-tagged intellect lookup for a *selected* model id — the one resolver
// features can use to answer "how capable is the model actually running this
// turn?" without hand-rolling the cloud/local fallback chain each time.
//
// `intellect-hints.ts` answers the same question for the picker, but it returns
// display strings; a policy that compares against a threshold needs the number
// **and the scale it is on**. That distinction is load-bearing: the canonical
// Artificial Analysis Intelligence Index (frontier ≈ 55–60) and the crystallised
// composite from `composite-intellect.ts` (a weighted mean of 0–100 pass-rate
// benchmarks) are deliberately different rulers that must never be ranked on one
// axis. So this module never blends them — it tags every value with its scale
// and leaves the caller to hold one threshold per scale.
//
// Resolution order, most-trustworthy first:
//  1. A local model's **quant-adjusted** canonical score — the model as it
//     actually runs on-device beats the full-precision number.
//  2. Any sourced canonical measurement for the id (cloud ids, OpenRouter ids,
//     ACP labels, provider-prefixed forms — `getIntellectScore` owns the alias
//     and wrapper stripping).
//  3. The local composite over the model's sourced benchmark axes.
//
// Null means "not sourced" — never zero, and never a guess.

import { compositeIntellect } from './composite-intellect.ts'
import {
  getLocalModelCapability,
  localBenchmarkScore,
  type BenchmarkScore,
  type LocalModelCapability,
} from './local-model-catalog.ts'
import { CANONICAL_INTELLECT_VERSION, getIntellectScore } from './model-intellect.ts'
import { LMSTUDIO_MODEL_PREFIX } from './reserved-prefixes.ts'

/**
 * Which ruler a resolved value is expressed on. The two are incomparable by
 * construction (see the scale warning in `composite-intellect.ts`), so a
 * consumer thresholding on intellect needs a threshold per scale.
 */
export type IntellectScale = 'canonical' | 'composite'

/** A model's capability number plus the scale and derivation behind it. */
export interface ResolvedIntellect {
  /** The score, on {@link scale}. */
  value: number
  scale: IntellectScale
  /** True when the value was derived (equated, quant-adjusted, or composite). */
  estimated: boolean
  /** Human-readable "why this number", for logs and explanatory UI. */
  basis: string
}

/** Human label for a scale, used in the `basis` strings and by consumers. */
export function describeIntellectScale(scale: IntellectScale): string {
  return scale === 'canonical'
    ? `Artificial Analysis Intelligence Index ${CANONICAL_INTELLECT_VERSION}`
    : 'Copse composite (0–100 benchmark mean)'
}

/**
 * The local catalog entry for a selection id: the bare weight id as the catalog
 * stores it, or the app's `lmstudio:<id>` picker form. Only that one structural
 * wrapper is stripped — the weight name itself is never fuzzy-matched.
 */
function localCapabilityFor(idOrLabel: string): LocalModelCapability | null {
  const direct = getLocalModelCapability(idOrLabel)
  if (direct) return direct
  if (idOrLabel.startsWith(LMSTUDIO_MODEL_PREFIX)) {
    return getLocalModelCapability(idOrLabel.slice(LMSTUDIO_MODEL_PREFIX.length))
  }
  return null
}

function canonical(score: BenchmarkScore): ResolvedIntellect {
  return {
    value: score.value,
    scale: 'canonical',
    estimated: score.estimated === true,
    basis: score.basis ?? score.source,
  }
}

/**
 * The capability score for whatever model id the app has selected, or null when
 * nothing is sourced for it. See the module header for the resolution order;
 * the returned {@link ResolvedIntellect.scale} tells the caller which ruler the
 * number is on.
 */
export function resolveModelIntellect(idOrLabel: string): ResolvedIntellect | null {
  const local = localCapabilityFor(idOrLabel)
  if (local) {
    const quantAdjusted = localBenchmarkScore(local, 'aa-intelligence')
    if (quantAdjusted) return canonical(quantAdjusted)
  }
  const measured = getIntellectScore(idOrLabel)
  if (measured) return canonical(measured)
  if (local) {
    const composite = compositeIntellect(local)
    if (composite) {
      return {
        value: composite.value,
        scale: 'composite',
        estimated: true,
        basis: composite.basis,
      }
    }
  }
  return null
}
