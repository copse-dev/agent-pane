import {
  createRoadmapWriteHandlers,
  type RoadmapWriteDependencies,
  type RoadmapWriteHandlers,
} from '../../src/main/ipc/roadmap-write-handlers.ts'
import type { KnowledgeNote } from '../../src/main/services/storage/knowledge-store.ts'
import type { KnowledgeAttachment } from '../../src/shared/knowledge/attachments.ts'

/** Real handler logic with in-memory I/O boundaries; no Electron or model service imports. */
export function roadmapWriteHarness(): {
  handlers: RoadmapWriteHandlers
  deps: RoadmapWriteDependencies
  notes: Map<string, KnowledgeNote>
  stamps: string[]
  deleted: string[]
  /** One entry per `notifyRoadmapChanged` broadcast. */
  changes: string[]
} {
  const notes = new Map<string, KnowledgeNote>()
  const stamps: string[] = []
  const deleted: string[] = []
  const changes: string[] = []
  let nextId = 0
  const deps: RoadmapWriteDependencies = {
    addKnowledgeNote(input) {
      const id = String(++nextId)
      const note: KnowledgeNote = {
        id,
        type: input.type,
        title: input.title,
        body: input.body,
        tags: input.tags ?? [],
        status: input.status ?? null,
        fields: { ...input.fields },
        file: `/fixture/${id}.md`,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }
      notes.set(id, note)
      return note
    },
    getKnowledgeNote: (id) => notes.get(id) ?? null,
    updateKnowledgeNote(id, patch) {
      const old = notes.get(id)
      if (!old) return null
      const note: KnowledgeNote = {
        ...old,
        title: patch.title ?? old.title,
        body: patch.body ?? old.body,
        tags: patch.tags ?? old.tags,
        status: patch.status === undefined ? old.status : patch.status,
        fields: patch.fields === undefined ? old.fields : { ...patch.fields },
      }
      notes.set(id, note)
      return note
    },
    deleteKnowledgeNote: (id) => notes.delete(id),
    loadKnowledgeNotes: (type) => [...notes.values()].filter((n) => !type || n.type === type),
    saveKnowledgeAttachments: (_id, adds) =>
      adds.map((add): KnowledgeAttachment => ({
        id: `attachment-${String(++nextId)}`,
        name: add.name,
        mimeType: add.mimeType,
        size: 1,
      })),
    deleteAllKnowledgeAttachments: (id) => {
      deleted.push(`all:${id}`)
    },
    deleteKnowledgeAttachmentFiles: (_id, attachments) => {
      deleted.push(...attachments.map((attachment) => attachment.id))
    },
    stampRoadmapComplexity: async () => {
      stamps.push('complexity')
    },
    stampRoadmapCategory: async () => {
      stamps.push('category')
    },
    stampRoadmapTitle: async () => {
      stamps.push('title')
    },
    notifyRoadmapChanged: () => {
      changes.push('roadmap:changed')
    },
  }
  return { handlers: createRoadmapWriteHandlers(deps), deps, notes, stamps, deleted, changes }
}
