import { parseComplexityWord, type RoadmapComplexity } from '@shared/roadmap/complexity.ts'
import {
  resolveSmallTasksProvider,
  resolveSmallTasksModelId,
} from './providers/small-tasks-provider.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { recordUsageEvent } from './storage/usage-ledger.ts'
import { getKnowledgeNote, updateKnowledgeNote } from './storage/knowledge-store.ts'

/**
 * One-shot complexity classification for a roadmap prompt, run when the prompt
 * is saved (create/update and issue import — explicit actions only, never
 * ambient). Saving never waits on it: the note persists immediately and the
 * complexity is stamped in the background (stampRoadmapComplexity).
 *
 * Classification is model-only via the configured small-tasks provider (the
 * local default used for titles/summaries). Keyword or model-routing heuristics
 * are not a substitute for a real judgement — when no provider answers in time
 * (or the reply is unparseable), the stamp is simply skipped and the item stays
 * without a complexity badge, same as fit-check.
 *
 * The ask spells out per-word calibration and tells the model medium is not a
 * safe default — small models otherwise middle-anchor a bare three-way choice
 * and stamp nearly every item `medium`.
 */

const CLASSIFY_TIMEOUT_MS = 10_000

const CLASSIFY_ASK =
  'Rate the implementation complexity of the coding task below as exactly one word: ' +
  'low, medium, or high.\n' +
  '- low: contained and well-specified — one or two files, mechanical or obvious steps ' +
  '(rename, copy/style tweak, config flag, small bug fix, adding a test).\n' +
  '- medium: a typical feature or fix — several files and some decisions, but a familiar ' +
  'shape (new UI control wired to existing state, new command, module-level change).\n' +
  '- high: cross-cutting or open-ended — new subsystem, architectural refactor or ' +
  'migration, concurrency/security-sensitive work, or a goal that needs design before code.\n' +
  'Use the whole scale: many roadmap items are genuinely low, and medium is not a safe ' +
  'default for uncertainty. If torn between two ratings, pick the lower one.\n' +
  'Reply with ONLY the word.\n\nTask:\n'

export async function classifyRoadmapComplexity(prompt: string): Promise<RoadmapComplexity | null> {
  const provider = await resolveSmallTasksProvider()
  if (!provider) return null
  const model = resolveSmallTasksModelId()
  const ask = CLASSIFY_ASK + prompt.slice(0, 2000)
  try {
    const { text, usage } = await completeTextWithUsage(provider, ask, CLASSIFY_TIMEOUT_MS)
    if (usage.inputTokens || usage.outputTokens) {
      recordUsageEvent({
        model,
        source: 'small-tasks',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })
    }
    return parseComplexityWord(text)
  } catch {
    return null
  }
}

/**
 * Classify `prompt` and stamp the verdict onto note `id`, detached from the
 * save that triggered it so persistence is immediate. The stamp is skipped when
 * the note was deleted or its prompt changed while the model ran — the newer
 * save owns (re)classification — or when the model returns no verdict.
 * `onStamped` fires only after a successful stamp (e.g. to refresh the pane).
 * Best-effort by design: a failed stamp just leaves the item without a
 * complexity badge, like pre-stamping items.
 */
export async function stampRoadmapComplexity(
  id: string,
  prompt: string,
  onStamped?: () => void,
  classify: (prompt: string) => Promise<RoadmapComplexity | null> = classifyRoadmapComplexity,
): Promise<void> {
  try {
    const complexity = await classify(prompt)
    if (complexity == null) return
    // Re-read after the await: only a note still carrying this exact prompt
    // takes the stamp (the store keeps bodies trimmed). The read-check-write
    // below is synchronous, so no other save can interleave with it.
    const note = getKnowledgeNote(id)
    if (!note || note.body !== prompt.trim()) return
    updateKnowledgeNote(id, { fields: { ...note.fields, complexity } })
    onStamped?.()
  } catch {
    // Never let a background stamp surface as an unhandled rejection.
  }
}
