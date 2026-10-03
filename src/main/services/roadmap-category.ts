import { ROADMAP_CATEGORIES, type RoadmapCategory } from '@shared/roadmap/complexity.ts'
import {
  askBackgroundChoice,
  type BackgroundChoiceQuestion,
} from './classifiers/background-classification.ts'
import { getKnowledgeNote, updateKnowledgeNote } from './storage/knowledge-store.ts'

/**
 * One-shot category classification for a roadmap prompt, run when the prompt
 * is saved (create/update and issue import — explicit actions only, never
 * ambient). Saving never waits on it: the note persists immediately and the
 * category is stamped in the background (stampRoadmapCategory).
 *
 * Classification is a background question (`background-classification.ts`):
 * the classifier connection chosen in Settings → Classifiers, else the
 * configured small-tasks provider, then the chat model. Keyword or
 * model-routing heuristics are not a substitute for a real judgement — when
 * nothing answers in time (or the reply is unparseable), the stamp is simply
 * skipped and the item stays without a category badge, same as complexity.
 *
 * The question spells out the per-word calibration so a small model doesn't
 * default everything to `feature` — bugs and multi-part projects are called
 * out explicitly. Feature comes before project, so a classifier's tie between
 * them picks feature, as the guidance asks.
 */

const CLASSIFY_TIMEOUT_MS = 10_000

export const ROADMAP_CATEGORY_QUESTION: BackgroundChoiceQuestion<RoadmapCategory> = {
  task: 'Classify the coding task below',
  choices: ROADMAP_CATEGORIES,
  describe: {
    bug:
      'fixing broken behavior — a crash, wrong output, an exception, a regression, ' +
      'or something that does not work as documented.',
    feature:
      'new functionality or an enhancement to existing behavior — a new control, ' +
      'command, option, or small improvement, contained to a familiar area.',
    project:
      'a multi-part initiative — a new subsystem, a migration, an architectural ' +
      'change, or a goal that needs design and several distinct pieces of work before it lands.',
  },
  guidance:
    'Use all three options: not every task is a feature. If torn between feature and project, ' +
    'pick feature unless the work clearly spans multiple coordinated pieces.',
  stateLabel: 'Task',
}

export async function classifyRoadmapCategory(prompt: string): Promise<RoadmapCategory | null> {
  const answer = await askBackgroundChoice(
    ROADMAP_CATEGORY_QUESTION,
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
 * category badge, like pre-stamping items.
 *
 * A stored category is never overwritten here when the user has manually set
 * one that differs from the verdict: callers gate the stamp on the prompt
 * itself changing, so notes/status edits keep a user-chosen category. This
 * function only stamps the verdict the model just produced for the current
 * prompt.
 */
export async function stampRoadmapCategory(
  id: string,
  prompt: string,
  onStamped?: () => void,
  classify: (prompt: string) => Promise<RoadmapCategory | null> = classifyRoadmapCategory,
): Promise<void> {
  try {
    const category = await classify(prompt)
    if (category == null) return
    // Re-read after the await: only a note still carrying this exact prompt
    // takes the stamp (the store keeps bodies trimmed). The read-check-write
    // below is synchronous, so no other save can interleave with it.
    const note = getKnowledgeNote(id)
    if (!note || note.body !== prompt.trim()) return
    // A user-set category (categoryManual flag) is never overwritten by the
    // model verdict — the user's choice wins until they clear it.
    if (note.fields['categoryManual']) return
    updateKnowledgeNote(id, { fields: { ...note.fields, category } })
    onStamped?.()
  } catch {
    // Never let a background stamp surface as an unhandled rejection.
  }
}
