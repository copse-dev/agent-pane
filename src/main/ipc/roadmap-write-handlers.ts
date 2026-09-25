import { z } from 'zod'
import { parseIssueRef } from '@shared/git/issue-ref.ts'
import { ROADMAP_STATUSES, ROADMAP_TYPE, roadmapTitleFromPrompt } from '@shared/roadmap/note.ts'
import {
  ATTACHMENTS_FIELD,
  MAX_NOTE_ATTACHMENTS,
  parseKnowledgeAttachments,
  serializeKnowledgeAttachments,
} from '@shared/knowledge/attachments.ts'
import { IpcValidationError, parseIpcArgs, zNonEmptyString } from './ipc-guards.ts'
import type * as notes from '../services/storage/knowledge-store.ts'
import type * as attachments from '../services/storage/knowledge-attachments.ts'
import type { stampRoadmapComplexity } from '../services/roadmap-complexity.ts'
import type { stampRoadmapCategory } from '../services/roadmap-category.ts'
import type { stampRoadmapTitle } from '../services/roadmap-title.ts'

/** Dependencies at the persistence/model boundary, supplied by the real IPC registration. */
export interface RoadmapWriteDependencies {
  addKnowledgeNote: typeof notes.addKnowledgeNote
  getKnowledgeNote: typeof notes.getKnowledgeNote
  updateKnowledgeNote: typeof notes.updateKnowledgeNote
  deleteKnowledgeNote: typeof notes.deleteKnowledgeNote
  loadKnowledgeNotes: typeof notes.loadKnowledgeNotes
  saveKnowledgeAttachments: typeof attachments.saveKnowledgeAttachments
  deleteAllKnowledgeAttachments: typeof attachments.deleteAllKnowledgeAttachments
  deleteKnowledgeAttachmentFiles: typeof attachments.deleteKnowledgeAttachmentFiles
  stampRoadmapComplexity: typeof stampRoadmapComplexity
  stampRoadmapCategory: typeof stampRoadmapCategory
  stampRoadmapTitle: typeof stampRoadmapTitle
  notifyRoadmapChanged: () => void
}

/**
 * Actual create/update/delete/thread-tracking logic; Electron sender
 * authorization stays at the IPC boundary.
 */
export interface RoadmapWriteHandlers {
  create(
    rawPrompt: unknown,
    rawNotes?: unknown,
    rawIssue?: unknown,
    rawAttachments?: unknown,
  ): notes.KnowledgeNote
  update(
    rawId: unknown,
    rawPrompt: unknown,
    rawNotes: unknown,
    rawStatus: unknown,
    rawIssue?: unknown,
    rawAddAttachments?: unknown,
    rawRemoveAttachmentIds?: unknown,
  ): notes.KnowledgeNote | null
  remove(rawId: unknown): boolean
  setThread(rawId: unknown, rawThreadId: unknown): notes.KnowledgeNote | null
  findByThread(rawThreadId: unknown): { id: string; title: string } | null
}

export function createRoadmapWriteHandlers(deps: RoadmapWriteDependencies): RoadmapWriteHandlers {
  const {
    addKnowledgeNote,
    getKnowledgeNote,
    updateKnowledgeNote,
    deleteKnowledgeNote,
    loadKnowledgeNotes,
    saveKnowledgeAttachments,
    deleteAllKnowledgeAttachments,
    deleteKnowledgeAttachmentFiles,
    stampRoadmapComplexity,
    stampRoadmapCategory,
    stampRoadmapTitle,
    notifyRoadmapChanged,
  } = deps
  const zRoadmapPrompt = z.string().max(1_000_000)
  const zRoadmapNotes = z.string().max(10_000)
  const zRoadmapIssue = z.string().max(256)
  const zRoadmapStatus = z.enum(ROADMAP_STATUSES)
  const zRoadmapId = zNonEmptyString.max(128)
  // Attachments arrive as base64 data URLs (what the pane's paste/drop/picker
  // produce); ~14 MB of base64 ≈ 10 MB decoded per attachment.
  const zRoadmapAttachmentAdds = z
    .array(
      z.object({
        name: zNonEmptyString.max(255),
        mimeType: z.string().max(128),
        dataUrl: z.string().max(14_000_000),
      }),
    )
    .max(MAX_NOTE_ATTACHMENTS)
  const zRoadmapAttachmentIds = z.array(zNonEmptyString.max(128)).max(MAX_NOTE_ATTACHMENTS)

  function roadmapFields(
    existing: Record<string, string>,
    notes: string,
    issue: string,
  ): Record<string, string> {
    const { notes: _n, issue: _i, ...rest } = existing
    return {
      ...rest,
      ...(notes ? { notes } : {}),
      ...(issue ? { issue } : {}),
    }
  }

  // Empty string unpins; anything else must canonicalize or the save is
  // rejected, so a typo never silently stores an unlinkable ref.
  function parseRoadmapIssue(raw: unknown): string {
    const input = parseIpcArgs(zRoadmapIssue.optional(), [raw])?.trim() ?? ''
    if (!input) return ''
    const ref = parseIssueRef(input)
    if (!ref) {
      throw new IpcValidationError(
        'Unrecognized issue reference — use #123, owner/repo#123, or a GitHub issue URL',
      )
    }
    return ref
  }

  function create(
    rawPrompt: unknown,
    rawNotes?: unknown,
    rawIssue?: unknown,
    rawAttachments?: unknown,
  ): notes.KnowledgeNote {
    const prompt = parseIpcArgs(zRoadmapPrompt, [rawPrompt]).trim()
    const notes = parseIpcArgs(zRoadmapNotes.optional(), [rawNotes])?.trim() ?? ''
    const issue = parseRoadmapIssue(rawIssue)
    const attachments = parseIpcArgs(zRoadmapAttachmentAdds.optional(), [rawAttachments]) ?? []
    if (!prompt) throw new IpcValidationError('Roadmap prompt must not be empty')
    const note = addKnowledgeNote({
      type: ROADMAP_TYPE,
      title: roadmapTitleFromPrompt(prompt),
      body: prompt,
      status: 'ready',
      fields: roadmapFields({}, notes, issue),
    })
    // Saving is immediate; the complexity/category classification and the
    // AI-generated short title (issue #2472) — all model round-trips — stamp
    // the note in the background and the pane refreshes on the events.
    void stampRoadmapComplexity(note.id, prompt, notifyRoadmapChanged)
    void stampRoadmapCategory(note.id, prompt, notifyRoadmapChanged)
    void stampRoadmapTitle(note.id, prompt, note.title, notifyRoadmapChanged)
    if (attachments.length === 0) return note
    // Attachment files are keyed by the note id, so they land in a second
    // step once addKnowledgeNote has minted it. If that metadata write fails
    // (or the note vanished under a concurrent delete), remove the payloads
    // again — nothing references them, and a "saved" item must never look
    // attachment-free while files linger on disk.
    const saved = saveKnowledgeAttachments(note.id, attachments)
    let updated: ReturnType<typeof updateKnowledgeNote> = null
    try {
      updated = updateKnowledgeNote(note.id, {
        fields: { ...note.fields, [ATTACHMENTS_FIELD]: serializeKnowledgeAttachments(saved) },
      })
    } finally {
      if (!updated) deleteAllKnowledgeAttachments(note.id)
    }
    return updated ?? note
  }

  function update(
    rawId: unknown,
    rawPrompt: unknown,
    rawNotes: unknown,
    rawStatus: unknown,
    rawIssue?: unknown,
    rawAddAttachments?: unknown,
    rawRemoveAttachmentIds?: unknown,
  ): notes.KnowledgeNote | null {
    const id = parseIpcArgs(zRoadmapId, [rawId])
    const prompt = parseIpcArgs(zRoadmapPrompt, [rawPrompt]).trim()
    const notes = parseIpcArgs(zRoadmapNotes.optional(), [rawNotes])?.trim() ?? ''
    const status = parseIpcArgs(zRoadmapStatus, [rawStatus])
    const issue = parseRoadmapIssue(rawIssue)
    const addAttachments =
      parseIpcArgs(zRoadmapAttachmentAdds.optional(), [rawAddAttachments]) ?? []
    const removeAttachmentIds =
      parseIpcArgs(zRoadmapAttachmentIds.optional(), [rawRemoveAttachmentIds]) ?? []
    if (!prompt) throw new IpcValidationError('Roadmap prompt must not be empty')
    const existing = getKnowledgeNote(id)
    if (!existing || existing.type !== ROADMAP_TYPE) return null
    const promptChanged = prompt !== existing.body
    const fields = roadmapFields(existing.fields, notes, issue)
    // Re-classify only when the prompt itself changed — a status or notes
    // edit keeps the stored complexity without a model round-trip. The stale
    // stamp is dropped now (it graded the old prompt) and the fresh one lands
    // in the background so the save itself is immediate.
    if (promptChanged) delete fields['complexity']
    if (promptChanged && !existing.fields['categoryManual']) {
      delete fields['category']
    }
    // A stored fit verdict judges a specific prompt/issue pair; either side
    // changing invalidates it (and its reasoning).
    if (promptChanged || issue !== (existing.fields['issue'] ?? '')) {
      delete fields['fit']
      delete fields['fitDetail']
      delete fields['reviewVerdict']
      delete fields['reviewDetail']
      delete fields['reviewAt']
    }
    const current = parseKnowledgeAttachments(existing.fields[ATTACHMENTS_FIELD])
    const removeSet = new Set(removeAttachmentIds)
    const removed = current.filter((att) => removeSet.has(att.id))
    let saved: ReturnType<typeof saveKnowledgeAttachments> = []
    if (addAttachments.length > 0 || removeAttachmentIds.length > 0) {
      const kept = current.filter((att) => !removeSet.has(att.id))
      if (kept.length + addAttachments.length > MAX_NOTE_ATTACHMENTS) {
        throw new IpcValidationError(
          `A roadmap item can hold at most ${String(MAX_NOTE_ATTACHMENTS)} attachments`,
        )
      }
      saved = saveKnowledgeAttachments(id, addAttachments)
      const next = [...kept, ...saved]
      if (next.length > 0) fields[ATTACHMENTS_FIELD] = serializeKnowledgeAttachments(next)
      // Literal key (= ATTACHMENTS_FIELD): no-dynamic-delete bars computed deletes.
      else delete fields['attachments']
    }
    // Persist the metadata before touching existing payload files: if the
    // note write fails, the old files stay on disk and stay referenced —
    // the freshly saved ones are merely orphaned, and are removed below.
    // Only after the note durably stops referencing the removed attachments
    // may their files go.
    let updated: ReturnType<typeof updateKnowledgeNote> = null
    try {
      updated = updateKnowledgeNote(id, {
        title: roadmapTitleFromPrompt(prompt),
        body: prompt,
        status,
        fields,
      })
    } finally {
      if (!updated) deleteKnowledgeAttachmentFiles(id, saved)
    }
    if (updated) deleteKnowledgeAttachmentFiles(id, removed)
    // Other surfaces mirror an item's title (the thread-side back-link chip,
    // #2501); tell them now rather than only when a background stamp lands.
    if (updated) notifyRoadmapChanged()
    if (updated && promptChanged) {
      void stampRoadmapComplexity(id, prompt, notifyRoadmapChanged)
      void stampRoadmapCategory(id, prompt, notifyRoadmapChanged)
      // The title just written above is the fresh truncation for the new
      // prompt; an AI-generated name (issue #2472) replaces it in the
      // background, same as on create.
      void stampRoadmapTitle(id, prompt, updated.title, notifyRoadmapChanged)
    }
    return updated
  }
  function remove(rawId: unknown): boolean {
    const id = parseIpcArgs(zRoadmapId, [rawId])
    const existing = getKnowledgeNote(id)
    if (!existing || existing.type !== ROADMAP_TYPE) return false
    const deleted = deleteKnowledgeNote(id)
    if (deleted) {
      deleteAllKnowledgeAttachments(id)
      // A deleted item must stop being offered as a thread's origin (#2501).
      notifyRoadmapChanged()
    }
    return deleted
  }

  // Track the chat thread started from an item ("Start thread" in the pane) in
  // a `thread` frontmatter field, so the pane can offer reopening it later.
  // Restamping is deliberate: starting a fresh thread from the same item points
  // the field at the newest one. An empty threadId clears the tracking.
  //
  // The new thread's own `threads_changed` fires (createThread) before this
  // stamp lands, so the thread-side back-link chip (#2501) cannot learn the
  // mapping from thread events alone. Broadcast on the shared
  // `roadmap:changed` channel so it (and the pane) pick the stamp up once it
  // durably lands, the same as a background complexity/category stamp.
  function setThread(rawId: unknown, rawThreadId: unknown): notes.KnowledgeNote | null {
    const id = parseIpcArgs(zRoadmapId, [rawId])
    const threadId = parseIpcArgs(z.string().max(128).optional(), [rawThreadId])?.trim() ?? ''
    const existing = getKnowledgeNote(id)
    if (!existing || existing.type !== ROADMAP_TYPE) return null
    const { thread: _thread, ...rest } = existing.fields
    const updated = updateKnowledgeNote(id, {
      fields: { ...rest, ...(threadId ? { thread: threadId } : {}) },
    })
    if (updated) notifyRoadmapChanged()
    return updated
  }

  // Reverse lookup for the thread-side back-link (#2501): the roadmap item
  // currently tracking `threadId` as its `thread` field. That field is
  // restamped to the newest thread on every "Start thread", so an item that
  // has since spawned a second thread only answers for the newer one — the
  // older thread's back-link quietly stops resolving rather than pointing at
  // the wrong item.
  function findByThread(rawThreadId: unknown): { id: string; title: string } | null {
    const threadId = parseIpcArgs(zNonEmptyString.max(128), [rawThreadId])
    const match = loadKnowledgeNotes(ROADMAP_TYPE).find((n) => n.fields['thread'] === threadId)
    return match ? { id: match.id, title: match.title } : null
  }

  return { create, update, remove, setThread, findByThread }
}
