import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { defineHandler } from './define-handler.ts'
import {
  memoriesCreateArgs,
  memoriesDeleteArgs,
  memoriesUpdateArgs,
} from './memory-handler-args.ts'
import { EXTERNAL_CONTEXT_FIELD, MEMORY_TYPE } from '../tools/memory-tools.ts'
import {
  addKnowledgeNote,
  deleteKnowledgeNote,
  getKnowledgeNote,
  loadKnowledgeNotes,
  updateKnowledgeNote,
} from '../services/storage/knowledge-store.ts'

export function registerMemoryHandlers(win: BrowserWindow): void {
  // OKF memories management. The renderer's Memories pane (issue #645, Phase 3)
  // reads and edits the `Memory` notes the agent's remember/recall tools author.
  // Only the Memory type is exposed; roadmap/other knowledge types stay internal.
  defineHandler(win, 'memories:list', z.tuple([]), () => loadKnowledgeNotes(MEMORY_TYPE))

  defineHandler(
    win,
    'memories:create',
    memoriesCreateArgs,
    (title, body, tags) => addKnowledgeNote({ type: MEMORY_TYPE, title, body, tags }),
    { errors: 'per-argument' },
  )

  defineHandler(
    win,
    'memories:update',
    memoriesUpdateArgs,
    (id, title, body, tags) => {
      // A user edit is a review: saving from the Memories pane clears the
      // saved-with-external-content marker (context-provenance plan, Phase 4).
      const current = getKnowledgeNote(id)
      const fields = current
        ? Object.fromEntries(
            Object.entries(current.fields).filter(([key]) => key !== EXTERNAL_CONTEXT_FIELD),
          )
        : undefined
      return updateKnowledgeNote(id, { title, body, tags, ...(fields ? { fields } : {}) })
    },
    { errors: 'per-argument' },
  )

  defineHandler(win, 'memories:delete', memoriesDeleteArgs, (id) => deleteKnowledgeNote(id))
}
