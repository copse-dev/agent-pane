import {
  parseComplexityWord,
  bandToComplexity,
  type RoadmapComplexity,
} from '@shared/roadmap/complexity.ts'
import {
  resolveSmallTasksProvider,
  resolveSmallTasksModelId,
} from './providers/small-tasks-provider.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { classifyModelForTask } from './providers/model-classifier.ts'
import { recordUsageEvent } from './storage/usage-ledger.ts'
import { getKnowledgeNote, updateKnowledgeNote } from './storage/knowledge-store.ts'

/**
 * One-shot complexity classification for a roadmap prompt, run when the prompt
 * is saved (create/update and issue import — explicit actions only, never
 * ambient). Saving never waits on it: the note persists immediately and the
 * complexity is stamped in the background (stampRoadmapComplexity). Prefers the
 * configured small-tasks model (the local default used for titles/summaries);
 * a short timeout plus the pure heuristic classifier (#557) as fallback bound
 * how long the stamp can lag the save.
 */

const CLASSIFY_TIMEOUT_MS = 10_000

function heuristicComplexity(prompt: string): RoadmapComplexity {
  return bandToComplexity(classifyModelForTask({ task: prompt }).band)
}

export async function classifyRoadmapComplexity(prompt: string): Promise<RoadmapComplexity> {
  const provider = await resolveSmallTasksProvider()
  if (!provider) return heuristicComplexity(prompt)
  const model = resolveSmallTasksModelId()
  const ask =
    'Classify the complexity of the following coding task as exactly one word — ' +
    'low (small mechanical change, one file, clear steps), ' +
    'medium (a feature or fix touching a few files), or ' +
    'high (cross-cutting refactor, new subsystem, or open-ended design work). ' +
    'Reply with ONLY the word.\n\nTask:\n' +
    prompt.slice(0, 2000)
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
    return parseComplexityWord(text) ?? heuristicComplexity(prompt)
  } catch {
    return heuristicComplexity(prompt)
  }
}

/**
 * Classify `prompt` and stamp the verdict onto note `id`, detached from the
 * save that triggered it so persistence is immediate. The stamp is skipped when
 * the note was deleted or its prompt changed while the model ran — the newer
 * save owns (re)classification. `onStamped` fires only after a successful stamp
 * (e.g. to refresh the pane). Best-effort by design: a failed stamp just leaves
 * the item without a complexity badge, like pre-stamping items.
 */
export async function stampRoadmapComplexity(
  id: string,
  prompt: string,
  onStamped?: () => void,
  classify: (prompt: string) => Promise<RoadmapComplexity> = classifyRoadmapComplexity,
): Promise<void> {
  try {
    const complexity = await classify(prompt)
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
