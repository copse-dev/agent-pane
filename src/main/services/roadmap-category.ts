import { parseCategoryWord, type RoadmapCategory } from '@shared/roadmap/complexity.ts'
import {
  resolveSmallTasksProvider,
  resolveSmallTasksModelId,
} from './providers/small-tasks-provider.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { recordUsageEvent } from './storage/usage-ledger.ts'
import { getKnowledgeNote, updateKnowledgeNote } from './storage/knowledge-store.ts'

/**
 * One-shot category classification for a roadmap prompt, run when the prompt
 * is saved (create/update and issue import — explicit actions only, never
 * ambient). Saving never waits on it: the note persists immediately and the
 * category is stamped in the background (stampRoadmapCategory).
 *
 * Classification is model-only via the configured small-tasks provider (the
 * local default used for titles/summaries). Keyword or model-routing heuristics
 * are not a substitute for a real judgement — when no provider answers in time
 * (or the reply is unparseable), the stamp is simply skipped and the item stays
 * without a category badge, same as complexity.
 *
 * The ask spells out the per-word calibration so a small model doesn't default
 * everything to `feature` — bugs and multi-part projects are called out
 * explicitly.
 */

const CLASSIFY_TIMEOUT_MS = 10_000

const CLASSIFY_ASK =
  'Classify the coding task below as exactly one word: bug, feature, or project.\n' +
  '- bug: fixing broken behavior — a crash, wrong output, an exception, a regression, ' +
  'or something that does not work as documented.\n' +
  '- feature: new functionality or an enhancement to existing behavior — a new control, ' +
  'command, option, or small improvement, contained to a familiar area.\n' +
  '- project: a multi-part initiative — a new subsystem, a migration, an architectural ' +
  'change, or a goal that needs design and several distinct pieces of work before it lands.\n' +
  'Use all three options: not every task is a feature. If torn between feature and project, ' +
  'pick feature unless the work clearly spans multiple coordinated pieces.\n' +
  'Reply with ONLY the word.\n\nTask:\n'

export async function classifyRoadmapCategory(prompt: string): Promise<RoadmapCategory | null> {
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
    return parseCategoryWord(text)
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
