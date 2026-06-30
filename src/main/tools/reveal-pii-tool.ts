import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getActiveRunThread } from '../services/thread-models.ts'
import { revealPlaceholder } from '../services/pii-redactor.ts'
import { requestApproval } from '../services/approval.ts'

/**
 * Reveal the real value behind a PII placeholder — but only with the user's
 * explicit, per-call approval. The placeholders exist because the experimental
 * PII redaction feature replaced personal data the user typed before the message
 * left the device; this tool is the sanctioned, auditable way back to a real
 * value when the agent genuinely needs it (e.g. to write it into a local file).
 */
export const revealPiiTool = defineTool({
  name: 'reveal_pii',
  description:
    'Reveal the real value behind a redacted PII placeholder such as [EMAIL_1] or [GIVEN_NAME_2]. ' +
    'The user typed these values, but they were replaced with placeholders before the message was sent, to keep personal data on-device. ' +
    'Only call this when you truly need the underlying value to complete the task (for example, to write it verbatim into a local file or command) — placeholders are usually enough to reason with. ' +
    'IMPORTANT: every call prompts the user to approve revealing that specific placeholder, and they may decline. If they decline, keep using the placeholder. Never guess, reconstruct, or hardcode the underlying value yourself.',
  parameters: z.object({
    placeholder: z.string().describe('The placeholder token to reveal, e.g. "[EMAIL_1]".'),
  }),
  async execute({ placeholder }) {
    const threadId = getActiveRunThread()
    if (!threadId) return 'No active conversation, so there is nothing to reveal.'

    const token = placeholder.trim()
    const value = revealPlaceholder(threadId, token)
    if (value === null) {
      return `"${token}" is not a known redacted placeholder in this conversation. Use it as-is.`
    }

    const decision = await requestApproval({
      type: 'pii',
      title: 'Reveal redacted personal data?',
      body:
        `The agent is asking to see the real value behind ${token}. ` +
        'Approving reveals it to the agent and, on the next step, sends it to the model provider. Decline to keep it on-device.',
      allowRemember: false,
    })

    if (!decision.approved) {
      return `The user declined to reveal ${token}. Continue using the placeholder.`
    }
    return `${token} = ${value}`
  },
})
