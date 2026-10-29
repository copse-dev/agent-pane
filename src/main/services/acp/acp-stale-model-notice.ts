import { acpModelChoiceLabel } from '@shared/acp.ts'
import type { AcpModelSelector } from '@shared/types/acp.ts'

/**
 * Markdown notice for when a thread's chosen model has dropped off the
 * agent's own list (e.g. after an agent version bump): the turn still runs,
 * on whichever model `selector.currentValue` names, but silently is wrong —
 * say so once in the transcript rather than leaving it to the picker's
 * easy-to-miss "(not currently advertised)" label.
 *
 * Kept apart from `acp-client.ts` so the e2e spec that renders it can import
 * the product's own copy without loading the ACP client.
 */
export function acpStaleModelNotice(selector: AcpModelSelector, requestedModel: string): string {
  const current = selector.choices.find((choice) => choice.value === selector.currentValue)
  const currentLabel = current ? acpModelChoiceLabel(current) : selector.currentValue
  return (
    `_This thread's model (**${requestedModel}**) is no longer offered by this agent — ` +
    `continuing on **${currentLabel}** instead. Pick another model in the footer._\n\n`
  )
}
