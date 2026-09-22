// Persisted dismissals for Copse Reviewer findings (docs/plans/copse-reviewer.md,
// Shell B: "each dismissible — with dismissal persisted to `knowledge-store.ts`
// so it stays dismissed"; P8).
//
// A dismissal is keyed by the finding's content-derived id (class, path, the
// anchored source and the claim — never a line number), so it survives a
// rebase and a push that leaves the anchored lines alone, and it lapses on its
// own the moment the code or the claim at that spot changes: a genuinely new
// problem at the same location mints a new id and is shown. Stored as one
// knowledge note per dismissal, per project, so it travels with the OKF store
// and shows up in the Knowledge pane like any other note.
import {
  addKnowledgeNote,
  deleteKnowledgeNote,
  loadKnowledgeNotes,
} from '../storage/knowledge-store.ts'

/** The knowledge note type dismissals are filed under. */
export const REVIEW_DISMISSAL_NOTE_TYPE = 'review-dismissal'

/** Frontmatter field carrying the finding id on a dismissal note. */
export const REVIEW_DISMISSAL_FINDING_FIELD = 'findingId'

export interface ReviewDismissalInput {
  /** The finding's content-derived id (`^[0-9a-f]{16}$`). */
  findingId: string
  path: string
  claim: string
  /** The finding's class, kept as a field so the note is searchable by it. */
  class: string
}

/** Every finding id the user has dismissed in the active project. */
export function loadDismissedFindingIds(): Set<string> {
  const ids = new Set<string>()
  for (const note of loadKnowledgeNotes(REVIEW_DISMISSAL_NOTE_TYPE)) {
    const id = note.fields[REVIEW_DISMISSAL_FINDING_FIELD]
    if (id !== undefined && id !== '') ids.add(id)
  }
  return ids
}

/** Record a dismissal. Idempotent: an already-dismissed finding gets no second note. */
export function dismissReviewFinding(input: ReviewDismissalInput): void {
  if (loadDismissedFindingIds().has(input.findingId)) return
  addKnowledgeNote({
    type: REVIEW_DISMISSAL_NOTE_TYPE,
    title: `${input.path}: ${input.claim}`.slice(0, 200),
    body: input.claim,
    tags: [input.class],
    fields: {
      [REVIEW_DISMISSAL_FINDING_FIELD]: input.findingId,
      path: input.path,
      class: input.class,
    },
  })
}

/** Remove every dismissal note for a finding. Returns whether one existed. */
export function restoreReviewFinding(findingId: string): boolean {
  let removed = false
  for (const note of loadKnowledgeNotes(REVIEW_DISMISSAL_NOTE_TYPE)) {
    if (note.fields[REVIEW_DISMISSAL_FINDING_FIELD] !== findingId) continue
    if (deleteKnowledgeNote(note.id)) removed = true
  }
  return removed
}
