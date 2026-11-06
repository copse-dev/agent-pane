import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zNonEmptyString } from './ipc-guards.ts'
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
  const zMemoryTitle = z.string().max(512)
  const zMemoryBody = z.string().max(1_000_000)
  const zMemoryTags = z.array(z.string().max(128)).max(64)

  ipcMain.handle('memories:list', (event) => {
    assertMainFrameSender(event, win)
    return loadKnowledgeNotes(MEMORY_TYPE)
  })

  ipcMain.handle(
    'memories:create',
    (event, rawTitle: unknown, rawBody: unknown, rawTags: unknown) => {
      assertMainFrameSender(event, win)
      const title = parseIpcArgs(zMemoryTitle, [rawTitle])
      const body = parseIpcArgs(zMemoryBody, [rawBody])
      const tags = parseIpcArgs(zMemoryTags.optional(), [rawTags])
      return addKnowledgeNote({ type: MEMORY_TYPE, title, body, tags })
    },
  )

  ipcMain.handle(
    'memories:update',
    (event, rawId: unknown, rawTitle: unknown, rawBody: unknown, rawTags: unknown) => {
      assertMainFrameSender(event, win)
      const id = parseIpcArgs(zNonEmptyString.max(128), [rawId])
      const title = parseIpcArgs(zMemoryTitle, [rawTitle])
      const body = parseIpcArgs(zMemoryBody, [rawBody])
      const tags = parseIpcArgs(zMemoryTags.optional(), [rawTags])
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
  )

  ipcMain.handle('memories:delete', (event, rawId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zNonEmptyString.max(128), [rawId])
    return deleteKnowledgeNote(id)
  })
}
