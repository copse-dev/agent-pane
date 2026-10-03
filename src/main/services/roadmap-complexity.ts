import { ROADMAP_COMPLEXITIES, type RoadmapComplexity } from '@shared/roadmap/complexity.ts'
import {
  askBackgroundChoice,
  type BackgroundChoiceQuestion,
} from './classifiers/background-classification.ts'
import { getKnowledgeNote, updateKnowledgeNote } from './storage/knowledge-store.ts'

/**
 * One-shot complexity classification for a roadmap prompt, run when the prompt
 * is saved (create/update and issue import — explicit actions only, never
 * ambient). Saving never waits on it: the note persists immediately and the
 * complexity is stamped in the background (stampRoadmapComplexity).
 *
 * Classification is a background question (`background-classification.ts`):
 * the classifier connection chosen in Settings → Classifiers, else the
 * configured small-tasks provider, then the chat model. Keyword or
 * model-routing heuristics are not a substitute for a real judgement — when
 * nothing answers in time (or the reply is unparseable), the stamp is simply
 * skipped and the item stays without a complexity badge, same as fit-check.
 *
 * The question spells out per-word calibration and says medium is not a safe
 * default — small models otherwise middle-anchor a bare three-way choice and
 * stamp nearly every item `medium`. Choices run low to high, so a classifier's
 * tie picks the lower rating, as the guidance asks.
 */

const CLASSIFY_TIMEOUT_MS = 10_000

export const ROADMAP_COMPLEXITY_QUESTION: BackgroundChoiceQuestion<RoadmapComplexity> = {
  task: 'Rate the implementation complexity of the coding task below',
  choices: ROADMAP_COMPLEXITIES,
  describe: {
    low:
      'contained and well-specified — one or two files, mechanical or obvious steps ' +
      '(rename, copy/style tweak, config flag, small bug fix, adding a test).',
    medium:
      'a typical feature or fix — several files and some decisions, but a familiar ' +
      'shape (new UI control wired to existing state, new command, module-level change).',
    high:
      'cross-cutting or open-ended — new subsystem, architectural refactor or ' +
      'migration, concurrency/security-sensitive work, or a goal that needs design before code.',
  },
  guidance:
    'Use the whole scale: many roadmap items are genuinely low, and medium is not a safe ' +
    'default for uncertainty. If torn between two ratings, pick the lower one.',
  stateLabel: 'Task',
}

export async function classifyRoadmapComplexity(prompt: string): Promise<RoadmapComplexity | null> {
  const answer = await askBackgroundChoice(
    ROADMAP_COMPLEXITY_QUESTION,
    prompt.slice(0, 2000),
    CLASSIFY_TIMEOUT_MS,
  )
  return answer?.choice ?? null
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
