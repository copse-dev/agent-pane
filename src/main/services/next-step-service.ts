import type { FollowUpContext } from '@shared/follow-ups/types.ts'
import { resolveSmallTasksRoute, type SmallTasksRoute } from './providers/small-tasks-provider.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { recordUsageEvent } from './storage/usage-ledger.ts'
import type { UsageRecordInput } from '@shared/usage/usage-event.ts'
import { getSetting } from './storage/settings.ts'

/**
 * A hint longer than this no longer fits the composer's one-line placeholder
 * slot — and a next step that needs a paragraph was not the "one obvious move"
 * the feature promises, so the whole suggestion is dropped rather than
 * truncated into something the user never actually saw before accepting.
 */
const MAX_HINT_LENGTH = 100

/**
 * Reduce raw model output to a single clean instruction line, or null when the
 * model declined (NONE) or produced something that cannot ride in a placeholder.
 */
export function cleanNextStep(raw: string): string | null {
  const line = raw
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '' && !part.startsWith('```'))
  if (!line) return null

  const text = line
    .replace(/^(?:[-*]\s+|\d+[.)]\s+)/, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.\s]+$/, '')
    .trim()
  if (!text) return null
  if (/^(?:none|nothing|n\/a|no (?:next step|suggestion))\b/i.test(text)) return null
  if (text.length > MAX_HINT_LENGTH) return null
  return text
}

/**
 * Fixed hint for e2e / headless screenshot validation — the placeholder, Tab
 * keycap, and accept path can all be driven without LM Studio or an API key.
 */
export function mockNextStepHint(): string {
  return 'Run the test suite to verify the fix'
}

/** Budget for the one-shot next-step completion. */
export const NEXT_STEP_TIMEOUT_MS = 15_000

/**
 * The I/O a suggestion performs, injected so unit tests can drive the real
 * gate, prompt, timeout and usage attribution without a model server.
 */
export interface NextStepDeps {
  resolveRoute: () => Promise<SmallTasksRoute | null>
  recordUsage: (input: UsageRecordInput) => void
}

const DEFAULT_NEXT_STEP_DEPS: NextStepDeps = {
  resolveRoute: resolveSmallTasksRoute,
  recordUsage: recordUsageEvent,
}

/**
 * The composer's Tab-completable next step: one short instruction the user
 * would almost certainly send next, or null — which is the expected answer for
 * most turns. Experimental and off by default; the gate lives here (not only in
 * the renderer) so a stale renderer can never bill a model call for a feature
 * the user has switched off.
 */
export async function suggestNextStep(
  context: FollowUpContext,
  deps: NextStepDeps = DEFAULT_NEXT_STEP_DEPS,
): Promise<string | null> {
  if (!getSetting<boolean>('nextStepSuggestionEnabled', false)) return null
  if (process.env['COPSE_PANEL_MOCK_NEXT_STEP'] === '1') {
    return mockNextStepHint()
  }

  const route = await deps.resolveRoute()
  if (!route) return null

  const toolSummary =
    context.toolNames.length > 0 ? `\nTools used: ${context.toolNames.join(', ')}` : ''
  const prompt =
    'An AI coding assistant just finished a turn. Decide whether there is ONE next step ' +
    'so obvious and valuable that the user would almost certainly send it as their next message.\n' +
    'Most turns have no such step: if the assistant asked the user a question, offered ' +
    'options to choose between, or the work is simply done, reply with exactly NONE.\n' +
    'Otherwise reply with ONLY that next step, phrased as a short imperative instruction ' +
    'under twelve words, no quotes and no explanation. ' +
    'Examples: Run the tests to verify the fix. Commit and push these changes.\n\n' +
    'User:\n' +
    context.userMessage.slice(0, 800) +
    '\n\nAssistant:\n' +
    context.assistantMessage.slice(0, 1200) +
    toolSummary

  try {
    // Usage is recorded under the model that actually answered (the chat model
    // when the small-tasks route fell back to it), and also for a call that
    // failed or timed out after the provider had already reported tokens.
    const { text } = await completeTextWithUsage(
      route.provider,
      prompt,
      NEXT_STEP_TIMEOUT_MS,
      (usage) => {
        if (!usage.inputTokens && !usage.outputTokens) return
        deps.recordUsage({
          model: route.model,
          source: 'small-tasks',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        })
      },
    )
    return cleanNextStep(text)
  } catch {
    return null
  }
}
