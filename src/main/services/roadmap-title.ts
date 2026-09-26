import { suggestRoadmapTitle } from './title-generator.ts'
import { getKnowledgeNote, updateKnowledgeNote } from './storage/knowledge-store.ts'

/**
 * AI-generated short name for a roadmap item (issue #2472) — the same
 * model-generated naming threads and terminals already get
 * (suggestThreadTitle / suggestTerminalTitle in title-generator.ts), used in
 * place of the plain `prompt.slice(0, 80)` truncation
 * (roadmapTitleFromPrompt, tools/roadmap-tools.ts) that every creation path
 * saves the item under first.
 *
 * Follows the same non-blocking shape as the complexity/category stamps
 * (roadmap-complexity.ts / roadmap-category.ts): the note is already saved
 * (under the truncation title) by the time this runs, so creating or editing
 * an item never waits on a model — this stamps the AI-generated title over it
 * in the background once (if) the small-tasks model answers. Skipped, leaving
 * the truncation in place, when: no small-tasks provider is configured or
 * reachable (settings/offline — the same gate `suggestRoadmapTitle` uses for
 * thread/terminal naming), the model call fails or times out, the note was
 * deleted or its prompt changed while the model ran (a newer save owns its own
 * title), or its title no longer matches `previousTitle` — the truncation this
 * stamp was kicked off for — because something else (a later stamp, or a
 * future manual rename) already replaced it. `onStamped` fires only after a
 * successful stamp (e.g. to refresh the pane).
 */
export async function stampRoadmapTitle(
  id: string,
  prompt: string,
  previousTitle: string,
  onStamped?: () => void,
  generate: (prompt: string) => Promise<string | null> = suggestRoadmapTitle,
): Promise<void> {
  try {
    const title = await generate(prompt)
    if (!title) return
    // Re-read after the await: only a note still carrying this exact prompt
    // (the store keeps bodies trimmed) and still showing the truncation title
    // this stamp started from takes the AI-generated name.
    const note = getKnowledgeNote(id)
    if (!note || note.body !== prompt.trim()) return
    if (note.title !== previousTitle) return
    updateKnowledgeNote(id, { title })
    onStamped?.()
  } catch {
    // Never let a background stamp surface as an unhandled rejection.
  }
}
