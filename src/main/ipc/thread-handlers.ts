import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { SPINE_SCHEMA_VERSION } from '@shared/threads/spine-schema.ts'
import { parseMessageValue, parseThreadValue } from '@shared/threads/thread-boundary.ts'
import { withoutMainOwnedThreadFields } from './thread-meta-guard.ts'
import { recordArrayOrEmpty } from '@shared/unknown-value.ts'
import { readPendingDeferrals } from '../services/security/deferred-approval-store.ts'
import { loadCanvasArtefactSummaries, readStoredCanvasArtefact } from '../services/canvas-store.ts'
import { CANVAS_ARTEFACT_CHANNEL } from '../services/canvas-dispatch.ts'
import {
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  zModelId,
  zNonEmptyString,
  zPathString,
  zProjectId,
  zThreadId,
} from './ipc-guards.ts'
import { storageGet } from '../services/storage/storage.ts'
import {
  searchThreadRequests,
  cancelThreadRequestSearch,
  warmThreadRequestSearch,
} from '../services/thread-request-search.ts'
import {
  measureThreadStorage,
  backfillThreadPrRefs,
  loadProjectThreadMetas,
  loadThreadMessages,
  createThreadWithResult,
  appendMessage,
  updateMeta,
  recordModelSelection,
  loadProjectCatalog,
  listOrphanProjectStores,
} from '../services/thread-store.ts'
import {
  recordProtectedPromptMessageAppend,
  recordProtectedPromptThreadCreate,
} from '../services/protected-prompt-receipts.ts'
import { deleteThreadResourcesAndStore } from '../services/thread-deletion.ts'
import { buildThreadArchive } from '../services/thread-archive.ts'
import { archiveStoredThread } from '../services/thread-archiving.ts'
import {
  getElectronAppVersion,
  getElectronBuildCommit,
  getElectronBuildDirty,
  isElectronAppPackaged,
} from '../services/electron-app-runtime.ts'
import {
  describeWorkspaceArchive,
  storeArchiveAttachment,
} from '../services/archive/archive-attachment-store.ts'
import {
  describeWorkspaceVideo,
  storeVideoAttachment,
  readVideoForPlayback,
} from '../services/video/video-attachment-store.ts'
import { forkThreadHistory } from '../services/thread-fork.ts'
import {
  applyThreadHistoryEdit,
  loadThreadHistorySnapshot,
  undoThreadHistoryEdit,
} from '../services/thread-history-edit.ts'
import { lookupThreadBacklinks } from '../services/thread-store.ts'
import type { ThreadAutoArchive } from '../services/thread-auto-archive.ts'
import type { ThreadAutoArchived } from '@shared/threads/auto-archive.ts'
import type { ThreadArchivingRuntime } from '../services/thread-archiving.ts'
import type { ThreadDeletionRuntime } from '../services/thread-deletion.ts'
import type { ThreadHistoryEditRuntime } from '../services/thread-history-edit.ts'

/** What the thread handlers share with the rest of `registerAllHandlers`. */
export interface ThreadHandlerDeps {
  autoArchive: ThreadAutoArchive
  notifyAutoArchive: (event: ThreadAutoArchived) => void
  threadArchivingRuntime: ThreadArchivingRuntime
  threadDeletionRuntime: ThreadDeletionRuntime
  threadHistoryEditRuntime: ThreadHistoryEditRuntime
}

export function registerThreadHandlers(
  win: BrowserWindow,
  {
    autoArchive,
    notifyAutoArchive,
    threadArchivingRuntime,
    threadDeletionRuntime,
    threadHistoryEditRuntime,
  }: ThreadHandlerDeps,
): void {
  ipcMain.handle('threads:storage-size', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, tid] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return measureThreadStorage(pid, tid)
  })
  ipcMain.handle('threads:load-project', (event, projectId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zProjectId, [projectId])
    // Archived threads stay on disk but are hidden from renderer surfaces.
    // The sidebar loads metadata only; legacy PR links are filled on demand
    // when their rows enter the visible viewport.
    return loadProjectThreadMetas(id, { includeArchived: false }).then((threads) => {
      warmThreadRequestSearch(id)
      return threads
    })
  })
  ipcMain.handle('threads:archive-state', async (event, projectId: unknown, view: unknown) => {
    assertMainFrameSender(event, win)
    const [id, mode] = parseIpcArgs(z.tuple([zProjectId, z.enum(['review', 'archived'])]), [
      projectId,
      view,
    ])
    if (mode === 'review') await autoArchive.sweep([id], notifyAutoArchive, false)
    const threads = mode === 'archived' ? await loadProjectThreadMetas(id) : []
    return {
      archived: threads.filter((thread) => thread.archivedAt != null && !thread.sideChat),
      review: autoArchive.review(id),
    }
  })
  ipcMain.handle(
    'threads:archive-decision',
    (event, projectId: unknown, threadId: unknown, decision: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, action] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.enum(['archive', 'keep', 'restore'])]),
        [projectId, threadId, decision],
      )
      return autoArchive.decide(pid, tid, action)
    },
  )
  ipcMain.handle('threads:backfill-pr-refs', async (event, projectId: unknown, ids: unknown) => {
    assertMainFrameSender(event, win)
    const [id, threadIds] = parseIpcArgs(z.tuple([zProjectId, z.array(zThreadId).min(1).max(10)]), [
      projectId,
      ids,
    ])
    await backfillThreadPrRefs(id, threadIds, (refs) => {
      if (!win.isDestroyed()) win.webContents.send('threads:pr-refs', id, refs)
    })
  })
  // PROTOTYPE (lazy thread loading): fetch one thread's transcript on demand,
  // when the user actually opens it.
  ipcMain.handle('threads:search-requests', (event, projectId: unknown, query: unknown) => {
    assertMainFrameSender(event, win)
    const [id, text] = parseIpcArgs(z.tuple([zProjectId, z.string().max(4096)]), [projectId, query])
    return searchThreadRequests(id, text)
  })
  ipcMain.handle('threads:cancel-request-search', (event) => {
    assertMainFrameSender(event, win)
    cancelThreadRequestSearch()
  })
  ipcMain.handle('threads:load-messages', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [id, thread] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return loadThreadMessages(id, thread)
  })
  // Canvas artefacts saved by earlier sessions. The renderer holds artefacts
  // only as live tabs and an in-memory thumbnail map, so after a restart these
  // two are the only way back to something the agent rendered yesterday.
  ipcMain.handle('canvas:list-artefacts', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [id, thread] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return loadCanvasArtefactSummaries(id, thread)
  })
  ipcMain.handle(
    'canvas:read-artefact',
    (event, projectId: unknown, threadId: unknown, title: unknown) => {
      assertMainFrameSender(event, win)
      const [id, thread, name] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.string().trim().min(1).max(200)]),
        [projectId, threadId, title],
      )
      return readStoredCanvasArtefact(id, thread, name)
    },
  )
  ipcMain.handle(
    'canvas:reopen-artefact',
    async (event, projectId: unknown, threadId: unknown, title: unknown) => {
      assertMainFrameSender(event, win)
      const [id, thread, name] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.string().trim().min(1).max(200)]),
        [projectId, threadId, title],
      )
      const artefact = await readStoredCanvasArtefact(id, thread, name)
      if (!artefact) return false
      // Delivered on the ordinary artefact channel so the Browser pane opens it
      // through exactly the path a fresh render takes — one behaviour, not two.
      event.sender.send(CANVAS_ARTEFACT_CHANNEL, artefact)
      return true
    },
  )
  ipcMain.handle('threads:create', async (event, projectId: unknown, thread: unknown) => {
    assertMainFrameSender(event, win)
    const [id, payload] = parseIpcArgs(z.tuple([zProjectId, z.record(z.string(), z.unknown())]), [
      projectId,
      thread,
    ])
    const parsed = parseThreadValue(withoutMainOwnedThreadFields(payload))
    if (parsed === null) throw new IpcValidationError('Invalid thread payload')
    const created = await createThreadWithResult(id, parsed)
    recordProtectedPromptThreadCreate(event.sender.id, id, parsed.id, created, parsed.messages)
  })
  ipcMain.handle(
    'threads:append-message',
    async (event, projectId: unknown, threadId: unknown, message: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, payload] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.record(z.string(), z.unknown())]),
        [projectId, threadId, message],
      )
      const parsed = parseMessageValue(payload)
      if (parsed === null) throw new IpcValidationError('Invalid message payload')
      const existing =
        parsed.role === 'user'
          ? (await loadThreadMessages(pid, tid)).some((candidate) => candidate.id === parsed.id)
          : true
      await appendMessage(pid, tid, parsed)
      if (!existing) recordProtectedPromptMessageAppend(event.sender.id, pid, tid, parsed.id)
    },
  )
  ipcMain.handle(
    'threads:update-meta',
    (event, projectId: unknown, threadId: unknown, patch: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, payload] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.record(z.string(), z.unknown())]),
        [projectId, threadId, patch],
      )
      return updateMeta(pid, tid, withoutMainOwnedThreadFields(payload))
    },
  )
  ipcMain.handle(
    'threads:record-model-selection',
    (event, projectId: unknown, threadId: unknown, by: unknown, from: unknown, to: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, actor, previous, selected] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.enum(['user', 'auto']), zModelId.optional(), zModelId]),
        [projectId, threadId, by, from, to],
      )
      const selection = {
        id: randomUUID(),
        recordedAt: Date.now(),
        by: actor,
        ...(previous !== undefined ? { from: previous } : {}),
        to: selected,
      }
      const line = {
        v: SPINE_SCHEMA_VERSION,
        type: 'model_selected' as const,
        ...selection,
      }
      return recordModelSelection(pid, tid, line).then(() => selection)
    },
  )
  ipcMain.handle(
    'threads:archive',
    (event, projectId: unknown, threadId: unknown, discard: unknown, stop: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, discardChanges, stopProcesses] = parseIpcArgs(
        z.tuple([
          zProjectId,
          zThreadId,
          z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
          z.boolean(),
        ]),
        [projectId, threadId, discard, stop],
      )
      return archiveStoredThread(pid, tid, discardChanges, stopProcesses, threadArchivingRuntime)
    },
  )
  ipcMain.handle('threads:delete', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, tid] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return deleteThreadResourcesAndStore(pid, tid, threadDeletionRuntime)
  })
  // Active threads that link to a URL or another thread: an indexed read of
  // recorded thread metadata that never touches a transcript.
  ipcMain.handle(
    'threads:backlinks',
    (event, projectId: unknown, kind: unknown, target: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, linkKind, linkTarget] = parseIpcArgs(
        z.tuple([zProjectId, z.enum(['url', 'thread']), z.string().min(1).max(2048)]),
        [projectId, kind, target],
      )
      return lookupThreadBacklinks(pid, linkKind, linkTarget)
    },
  )
  ipcMain.handle('threads:pending-approvals', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, tid] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return readPendingDeferrals({ projectId: pid, threadId: tid })
  })
  // Seed a freshly created fork's provider-format history from the thread it was
  // branched off. The renderer owns the visible transcript copy; this is the
  // half it cannot do, since `agent-history.json` never leaves the main process.
  ipcMain.handle(
    'threads:fork',
    (
      event,
      projectId: unknown,
      sourceThreadId: unknown,
      targetThreadId: unknown,
      throughMessageId: unknown,
    ) => {
      assertMainFrameSender(event, win)
      const [pid, sourceId, targetId, messageId] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, zThreadId, zNonEmptyString.max(256).optional()]),
        [projectId, sourceThreadId, targetThreadId, throughMessageId],
      )
      return forkThreadHistory(pid, sourceId, targetId, messageId)
    },
  )
  ipcMain.handle('threads:history-snapshot', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, tid] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return loadThreadHistorySnapshot(pid, tid)
  })
  ipcMain.handle(
    'threads:edit-history',
    (event, projectId: unknown, threadId: unknown, request: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, payload] = parseIpcArgs(
        z.tuple([
          zProjectId,
          zThreadId,
          z.object({
            expectedRevision: z.string().length(64),
            messages: z
              .array(
                z.object({
                  id: zNonEmptyString.max(256),
                  content: z.string().max(1_000_000),
                  included: z.boolean(),
                }),
              )
              .max(10_000),
          }),
        ]),
        [projectId, threadId, request],
      )
      return applyThreadHistoryEdit(pid, tid, payload, threadHistoryEditRuntime)
    },
  )
  ipcMain.handle(
    'threads:undo-history-edit',
    (event, projectId: unknown, threadId: unknown, expectedRevision: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, revision] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.string().length(64)]),
        [projectId, threadId, expectedRevision],
      )
      return undoThreadHistoryEdit(pid, tid, revision, threadHistoryEditRuntime)
    },
  )
  // The whole thread directory, zipped — the archive counterpart to the
  // renderer-side JSONL export. Bytes go back over IPC; the renderer names the
  // download and saves it, exactly as it does for the `.jsonl`.
  ipcMain.handle('threads:export-archive', async (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, tid] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return {
      bytes: await buildThreadArchive(pid, tid),
      build: {
        version: getElectronAppVersion(),
        buildCommit: getElectronBuildCommit(),
        buildDirty: getElectronBuildDirty(),
        packaged: isElectronAppPackaged(),
        platform: process.platform,
        capturedAt: new Date().toISOString(),
      },
    }
  })
  ipcMain.handle('threads:catalog', (event, projectId: unknown, query: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, q] = parseIpcArgs(z.tuple([zProjectId, z.string().max(512).optional()]), [
      projectId,
      query,
    ])
    return loadProjectCatalog(pid, q)
  })
  // A video attached in the composer. It is stored, never inlined — the
  // renderer gets back a path to hand the agent (see video-attachment-store).
  ipcMain.handle(
    'video:attach',
    async (event, projectId: unknown, threadId: unknown, video: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, payload] = parseIpcArgs(
        z.tuple([
          zProjectId,
          zThreadId,
          z.object({
            name: zNonEmptyString.max(255),
            mimeType: z.string().max(128),
            bytes: z.instanceof(Uint8Array).optional(),
            path: zPathString.optional(),
          }),
        ]),
        [projectId, threadId, video],
      )
      if (payload.path !== undefined) {
        // Already on disk in the workspace: reference it in place rather than
        // storing a second copy of a potentially very large file.
        return describeWorkspaceVideo(payload.path, payload.name, payload.mimeType)
      }
      if (!payload.bytes) throw new IpcValidationError('A video needs either bytes or a path')
      return storeVideoAttachment(pid, tid, {
        name: payload.name,
        mimeType: payload.mimeType,
        bytes: payload.bytes,
      })
    },
  )

  // An archive attached in the composer. Stored, never inlined — the renderer
  // gets back a path to hand the agent, which unpacks it with `read_archive`.
  ipcMain.handle(
    'archive:attach',
    async (event, projectId: unknown, threadId: unknown, archive: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, payload] = parseIpcArgs(
        z.tuple([
          zProjectId,
          zThreadId,
          z.object({
            name: zNonEmptyString.max(255),
            bytes: z.instanceof(Uint8Array).optional(),
            path: zPathString.optional(),
          }),
        ]),
        [projectId, threadId, archive],
      )
      if (payload.path !== undefined) {
        // Already on disk in the workspace: reference it in place rather than
        // storing a second copy.
        return describeWorkspaceArchive(payload.path, payload.name)
      }
      if (!payload.bytes) throw new IpcValidationError('An archive needs either bytes or a path')
      return storeArchiveAttachment(pid, tid, { name: payload.name, bytes: payload.bytes })
    },
  )

  // Read an attached video back so the preview modal can play it. Authorised to
  // the chat store and the workspace only — see readVideoForPlayback.
  ipcMain.handle('video:read', async (event, path: unknown) => {
    assertMainFrameSender(event, win)
    const videoPath = parseIpcArgs(zPathString, [path])
    return readVideoForPlayback(videoPath)
  })

  ipcMain.handle('threads:list-orphans', (event) => {
    assertMainFrameSender(event, win)
    const projectIds = recordArrayOrEmpty(storageGet('projects')).flatMap((project) => {
      const id = project['id']
      return typeof id === 'string' && id.length > 0 ? [id] : []
    })
    return listOrphanProjectStores(projectIds)
  })
}
