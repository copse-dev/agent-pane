import { isDynamicModel } from '@copse/llm/dynamic-model.ts'
import { DEFAULT_SAFETY_MODEL } from '@shared/lm-studio-defaults.ts'
import { FETCH_TIMEOUTS } from '../fetch-timeouts.ts'
import { resolveDynamicModelId } from '../providers/dynamic-model.ts'
import { normalizeRoleModelSelection } from '../providers/provider-selection.ts'
import { getSettingTrimmed } from '../storage/settings.ts'
import type { SafetyModelProblem } from './safety-model-availability.ts'
import {
  coolingDownSafetyModels,
  isSafetyModelCoolingDown,
  safetyModelCoolingDownProblem,
} from './safety-model-cooldown.ts'

/**
 * Which model screening actually runs on for this call.
 *
 * Both classifiers (`safety-classifier.ts` for shell scope, `terminal-read-guard.ts`
 * for scrollback) route through here so a model that has proved too slow is
 * skipped in both, and so the choice of stand-in is made once.
 */

/** The outcome of choosing a model to screen with. */
export interface SafetyScreeningModel {
  /** The model to send the screening request to; empty when there is none. */
  model: string
  /**
   * Set only when screening cannot run at all. An empty `model` with no problem
   * means the user has cleared the setting, which is a deliberate opt-out
   * rather than a fault.
   */
  problem: SafetyModelProblem | null
}

/**
 * The model the settings point at, with `auto:` rules expanded.
 *
 * The stored setting may be a rule (the default is one), so expand it before
 * anything treats the value as an id. The result is what gets checked for
 * availability, routed, and billed to the usage ledger.
 */
function storedSafetySelection(): string {
  return normalizeRoleModelSelection(getSettingTrimmed('safetyModel', DEFAULT_SAFETY_MODEL))
}

export async function resolveSafetyScreeningModel(): Promise<SafetyScreeningModel> {
  const stored = storedSafetySelection()
  const configured = await resolveDynamicModelId(stored)
  if (!configured) return { model: '', problem: null }
  if (!isSafetyModelCoolingDown(configured)) return { model: configured, problem: null }

  // The configured model is being routed around, so pick again from the same
  // rule with every cooling-down model excluded. Re-picking beats naming a
  // stand-in outright (the small-tasks role was the alternative): the safety
  // role's rule carries an intelligence floor, and a model too weak to hold the
  // output format screens no better than not screening at all — it just fails
  // to parse and asks the user anyway, which is the fault this replaces.
  //
  // A pinned selection ignores `exclude` — resolution returns a pinned id
  // verbatim — so it falls back to the role's own rule instead. Overriding an
  // explicit choice needs saying, and it is: the timeout was already recorded
  // on the decision log and surfaced in the approval that followed it.
  const rule = isDynamicModel(stored) ? stored : DEFAULT_SAFETY_MODEL
  const fallback = await resolveDynamicModelId(rule, { exclude: coolingDownSafetyModels() })

  // `resolveDynamicModelId` treats `exclude` as a preference and hands back a
  // colliding model rather than nothing, which is right for a chat model and
  // wrong here — returning the cooling-down model would re-pay the budget we
  // just decided not to spend. Fail closed instead: no verdict, and the read
  // goes to the user.
  if (!fallback || isSafetyModelCoolingDown(fallback)) {
    return {
      model: '',
      problem: safetyModelCoolingDownProblem(configured, FETCH_TIMEOUTS.safetyClassification),
    }
  }
  return { model: fallback, problem: null }
}
