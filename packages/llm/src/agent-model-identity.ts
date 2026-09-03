// Which model a coding agent means, given the names it chose to advertise.
//
// An ACP agent names its models in its own house style: a bare family value
// (`opus`), a label whose version hides in the description ("Opus" / "Opus 5
// with 1M context"), or another vendor's word order ("Claude 4.6 Sonnet"). Two
// surfaces have to agree on what those denote — the picker, which annotates the
// row with an intellect hint, and the routable frontier every `auto:` selector
// picks from. They resolved it separately and the frontier's chain was the
// narrower of the two, so a model the picker could name and score was silently
// missing from the pool: a plan-covered ACP route lost by never being a
// candidate at all. One resolver, used by both, is what keeps them level.

import { getIntellectScore, resolveIntellectModelId } from './model-intellect.ts'
import { claudeModelIdFromLabel } from './model-label.ts'

/**
 * The canonical model id an agent's own spellings denote — the first form that
 * resolves to a model with a sourced measurement — or null when none do.
 *
 * Forms are tried in the order given, the caller's own order of confidence.
 * The alias map runs over all of them first, and only then the Anthropic id a
 * plain family + version denotes, so a spelling no alias covers still finds its
 * measurement without a *later* form's alias being beaten by an *earlier*
 * form's guess. Requiring a score keeps the answer to models the app can
 * actually place: an id that resolves but was never measured is no better than
 * no answer, and pretending otherwise puts an unscorable row on the frontier.
 */
export function resolveAgentModelIdentity(
  ...forms: ReadonlyArray<string | null | undefined>
): string | null {
  const named = forms.filter((form): form is string => Boolean(form))
  for (const form of named) {
    const id = resolveIntellectModelId(form)
    if (id !== null && getIntellectScore(id)) return id
  }
  for (const form of named) {
    const labelled = claudeModelIdFromLabel(form)
    const id = labelled === null ? null : resolveIntellectModelId(labelled)
    if (id !== null && getIntellectScore(id)) return id
  }
  return null
}
