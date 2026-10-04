import { isAcpModel } from './acp.ts'
import { isLocalModel } from '@copse/llm/estimate-cost.ts'
import { getLocalModelCapability } from '@copse/llm/local-model-catalog.ts'
import { intellectBand, modelIntellect, topAnnotatedIntellect } from '@copse/llm/model-intellect.ts'
import { isDynamicModel } from '@copse/llm/dynamic-model.ts'

/**
 * Native advisor-tool compatibility table (executor -> allowed advisors), taken
 * verbatim from the docs. The advisor must be Claude Sonnet 4.6 or stronger and
 * at least as capable as the executor. We use this only as *advisory* UX: to
 * tell the user when a Claude/Claude pairing would also work with the native
 * server tool, keeping a future native switch clean. The client-side strategy
 * itself imposes no such restriction. the executor can be any model.
 */
const NATIVE_ADVISOR_COMPAT: Record<string, readonly string[]> = {
  'claude-haiku-4-5': [
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
  ],
  'claude-sonnet-4-6': [
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
  ],
  'claude-sonnet-5': ['claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4-7'],
  'claude-opus-4-6': [
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
  ],
  'claude-opus-4-7': ['claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4-7'],
  'claude-opus-4-8': ['claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4-7'],
  'claude-fable-5': ['claude-fable-5'],
  'claude-mythos-5': ['claude-mythos-5'],
}

/** True when (executor, advisor) is a valid pair for the native advisor tool. */
export function isNativeAdvisorPair(executorModel: string, advisorModel: string): boolean {
  return NATIVE_ADVISOR_COMPAT[executorModel]?.includes(advisorModel) ?? false
}

export interface AdvisorPairAssessment {
  /** Whether to allow the pairing at all (client-side is permissive). */
  ok: boolean
  /** Whether this pairing would also work with the native `advisor_20260301` tool. */
  native: boolean
  /**
   * Severity for the settings UI: `good` = the pairing the strategy is designed
   * for, `info` = works but nothing special, `warn` = the annotations say the
   * advisor is unlikely to add lift.
   */
  level: 'good' | 'info' | 'warn'
  /** Human-readable note for the settings UI. */
  reason: string
}

/**
 * What the model annotations know about a model's capability: an intellect
 * number for the tracked cloud models (`model-intellect.ts`), sizing for
 * catalogued local models (`local-model-catalog.ts`), or nothing
 * (OpenRouter / ACP / uncatalogued ids).
 */
type CapabilityAnnotation =
  | { kind: 'cloud'; intellect: number }
  | { kind: 'local'; paramsB: number | null }
  | { kind: 'unknown' }

/**
 * How far apart two intellect values must be before one model counts as
 * genuinely stronger than the other.
 *
 * The scale this reads used to be a 3-12 ordinal, where integer granularity
 * acted as an implicit tolerance. two models a fraction apart in capability
 * shared a rank and were treated as equals. The canonical Index scale is
 * continuous, so without an explicit band a 0.3-point gap would be reported as
 * "stronger", overselling noise as a capability difference. Two points is a few
 * percent of the catalog's span: comfortably inside measurement noise, well
 * below a real generational step.
 */
const INTELLECT_PARITY = 2

/**
 * Intellect for display. The canonical scale is continuous, so a value can
 * carry float noise from cross-version equating; one decimal is the precision
 * the Index itself publishes.
 */
function formatIntellect(value: number): string {
  return String(Math.round(value * 10) / 10)
}

function annotationFor(model: string): CapabilityAnnotation {
  if (isLocalModel(model)) {
    const bareId = model.startsWith('lmstudio:') ? model.slice('lmstudio:'.length) : model
    return { kind: 'local', paramsB: getLocalModelCapability(bareId)?.paramsB ?? null }
  }
  const intellect = modelIntellect(model)
  return intellect !== null ? { kind: 'cloud', intellect } : { kind: 'unknown' }
}

/** Compare two scores on the shared cloud scale using the parity tolerance. */
export function cloudAdvisorAddsLift(executorIntellect: number, advisorIntellect: number): boolean {
  return advisorIntellect >= executorIntellect - INTELLECT_PARITY
}

/**
 * Grade two cloud-model scores without consulting the generated model table.
 * Keeping this boundary pure lets behavioral tests use stable score fixtures,
 * while `validateAdvisorPair` remains the integration with live synced data.
 */
export function assessCloudAdvisorPair(
  executorIntellect: number,
  advisorIntellect: number,
): Omit<AdvisorPairAssessment, 'native'> {
  const diff = advisorIntellect - executorIntellect
  if (diff > INTELLECT_PARITY) {
    return {
      ok: true,
      level: 'good',
      reason: `Advisor is stronger than the executor (intellect ${formatIntellect(advisorIntellect)} vs ${formatIntellect(executorIntellect)}).`,
    }
  }
  if (Math.abs(diff) <= INTELLECT_PARITY) {
    return {
      ok: true,
      level: 'info',
      reason: `Advisor and executor are at the same intellect (${formatIntellect(advisorIntellect)}). expect a second opinion rather than stronger guidance.`,
    }
  }
  return {
    ok: true,
    level: 'warn',
    reason: `Advisor is weaker than the executor (intellect ${formatIntellect(advisorIntellect)} vs ${formatIntellect(executorIntellect)}). its advice is unlikely to add lift, so the advisor tool is hidden for this pairing.`,
  }
}

/**
 * Whether the `advisor` tool is worth offering for this (executor, advisor)
 * pairing. used to hide the tool when a stronger executor would gain nothing
 * from a weaker advisor. Deliberately conservative: it only returns `false`
 * when the annotations give *confident, same-scale* evidence the advisor is not
 * more capable than the executor —
 *
 * - the same model on both sides (no lift by definition),
 * - two annotated cloud models where the advisor's intellect is lower,
 * - two catalogued local models where the advisor has fewer parameters.
 *
 * Cross-scale pairings (local advisor vs cloud executor, or anything
 * unannotated. OpenRouter / ACP / uncatalogued) can't be compared, so it
 * returns `true` (keep offering) rather than hide a possibly-useful tool. This
 * is a superset-safe gate: hiding is stricter than the `warn` the settings hint
 * shows, so we only hide when certain.
 *
 * Both arguments must be *concrete* model ids. A dynamic selector such as the
 * default `auto:best-intellect` names a rule, not a model, so it carries no
 * annotation and would always read as "keep offering". even when it resolves
 * to the executor's own model. Expand it first (`resolveAdvisorModelForGating`
 * in advisor-runner.ts does).
 */
export function advisorAddsLift(executorModel: string, advisorModel: string): boolean {
  if (executorModel === advisorModel) return false
  const executor = annotationFor(executorModel)
  const advisor = annotationFor(advisorModel)
  if (executor.kind === 'cloud' && advisor.kind === 'cloud') {
    return cloudAdvisorAddsLift(executor.intellect, advisor.intellect)
  }
  if (
    executor.kind === 'local' &&
    advisor.kind === 'local' &&
    executor.paramsB !== null &&
    advisor.paramsB !== null
  ) {
    return advisor.paramsB >= executor.paramsB
  }
  return true
}

/**
 * Assess an (executor, advisor) pairing for the client-side strategy. Permissive
 * by design. the only pairing we refuse to bless is advising with the *same*
 * model, which buys nothing. Everything else is allowed, but the model
 * annotations (cloud capability tiers, local catalog sizing) grade how much
 * lift to expect so the settings UI can steer the user toward a genuinely
 * stronger advisor. Also reports whether the pairing is native-compatible so
 * the UI can hint at a future zero-change switch to the server tool.
 */
export function validateAdvisorPair(
  executorModel: string,
  advisorModel: string,
): AdvisorPairAssessment {
  const native = isNativeAdvisorPair(executorModel, advisorModel)
  if (executorModel === advisorModel) {
    return {
      ok: false,
      native,
      level: 'warn',
      reason:
        'Advisor and executor are the same model. pick a stronger advisor to get any lift. The advisor tool stays hidden while they match.',
    }
  }
  if (native) {
    return {
      ok: true,
      native,
      level: 'good',
      reason: 'Native-compatible pairing: also valid for Claude’s server-side advisor tool.',
    }
  }
  // A dynamic selection names a *rule*, not a model, so there is nothing to
  // grade until it resolves. Settings expands both sides through
  // `models:resolve-dynamic` before calling this; the branch covers callers that
  // cannot (and a selector nobody has resolved yet).
  if (isDynamicModel(advisorModel) || isDynamicModel(executorModel)) {
    return {
      ok: true,
      native,
      level: 'info',
      reason:
        'One side of this pairing is chosen dynamically, so the model is picked when the advisor actually runs. the strength comparison happens then.',
    }
  }
  if (isAcpModel(advisorModel)) {
    // Advice routed through an external ACP agent (acp-advisor.ts). The agent
    // owns its own model, so there is no annotation to compare against.
    return {
      ok: true,
      native,
      level: 'info',
      reason:
        'Advice comes from the configured external coding agent, consulted on a bare one-off session. No capability annotations, so no strength comparison.',
    }
  }

  const executor = annotationFor(executorModel)
  const advisor = annotationFor(advisorModel)

  if (advisor.kind === 'cloud' && executor.kind === 'local') {
    // The pairing the strategy exists for: work stays on device, top-of-scale
    // intelligence is pulled in at the moments that matter. Bands are derived
    // from the annotated distribution, so this judgement self-corrects when a
    // stronger model extends the scale.
    const band = intellectBand(advisor.intellect)
    if (band === 'top') {
      return {
        ok: true,
        native,
        level: 'good',
        reason:
          'Recommended pairing: an on-device executor consulting a top-of-scale cloud advisor. the setup this strategy is designed for.',
      }
    }
    return {
      ok: true,
      native,
      level: band === 'low' ? 'warn' : 'info',
      reason: `On-device executor with a cloud advisor at intellect ${formatIntellect(advisor.intellect)} of ${formatIntellect(topAnnotatedIntellect())}. a stronger advisor gives more lift.`,
    }
  }

  if (advisor.kind === 'cloud' && executor.kind === 'cloud') {
    return { native, ...assessCloudAdvisorPair(executor.intellect, advisor.intellect) }
  }

  if (advisor.kind === 'cloud') {
    // Executor has no annotation (OpenRouter / ACP / uncatalogued id).
    return {
      ok: true,
      native,
      level: 'info',
      reason: `Cloud advisor at intellect ${formatIntellect(advisor.intellect)} of ${formatIntellect(topAnnotatedIntellect())}; the executor isn’t in the capability annotations, so no strength comparison is possible.`,
    }
  }

  if (advisor.kind === 'local') {
    if (executor.kind === 'local' && advisor.paramsB !== null && executor.paramsB !== null) {
      if (advisor.paramsB > executor.paramsB) {
        return {
          ok: true,
          native,
          level: 'info',
          reason: `Advisor is a larger local model (~${String(advisor.paramsB)}B vs ~${String(executor.paramsB)}B). modest lift; a frontier cloud advisor gives more.`,
        }
      }
      const hidden = advisor.paramsB < executor.paramsB
      return {
        ok: true,
        native,
        level: 'warn',
        reason: `Advisor (~${String(advisor.paramsB)}B) is not larger than the executor (~${String(executor.paramsB)}B). pick a bigger model to get any lift.${
          hidden ? ' The advisor tool is hidden for this pairing.' : ''
        }`,
      }
    }
    return {
      ok: true,
      native,
      level: 'warn',
      reason:
        'A local advisor is unlikely to out-think the executor. this strategy expects a larger (ideally frontier cloud) advisor.',
    }
  }

  return {
    ok: true,
    native,
    level: 'info',
    reason:
      'Client-side pairing. any configured executor/advisor combination works. Neither model carries capability annotations, so no strength comparison is possible.',
  }
}
