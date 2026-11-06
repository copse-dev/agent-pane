import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { getProjectById } from '../services/workspace.ts'
import {
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  zNonEmptyString,
} from './ipc-guards.ts'
import { currentProjectStoreScope } from '../services/storage/project-namespace.ts'
import { ROADMAP_STATUSES, ROADMAP_TYPE } from '@shared/roadmap/note.ts'
import { createRoadmapWriteHandlers } from './roadmap-write-handlers.ts'
import { ROADMAP_CATEGORIES, isRoadmapCategory } from '@shared/roadmap/complexity.ts'
import {
  addKnowledgeNote,
  deleteKnowledgeNote,
  getKnowledgeNote,
  loadKnowledgeNotes,
  setKnowledgeNoteStatus,
  updateKnowledgeNote,
} from '../services/storage/knowledge-store.ts'
import {
  deleteAllKnowledgeAttachments,
  deleteKnowledgeAttachmentFiles,
  readKnowledgeAttachmentDataUrl,
  saveKnowledgeAttachments,
} from '../services/storage/knowledge-attachments.ts'
import { ATTACHMENTS_FIELD, parseKnowledgeAttachments } from '@shared/knowledge/attachments.ts'
import { getGithubRepoSlug } from '../services/github/git-service.ts'
import { issueRefToUrl } from '@shared/git/issue-ref.ts'
import { resolveGitHubBackend } from '../services/github/backend/backend.ts'
import { importIssuesAsRoadmapItems } from '../services/roadmap-issue-import.ts'
import { matchOpenIssuesToRoadmapItems } from '../services/roadmap-issue-coverage.ts'
import { stampRoadmapComplexity } from '../services/roadmap-complexity.ts'
import { stampRoadmapCategory } from '../services/roadmap-category.ts'
import { stampRoadmapTitle } from '../services/roadmap-title.ts'
import { notifyRoadmapChanged } from '../services/roadmap-events.ts'
import { checkRoadmapFit } from '../services/roadmap-fit-check.ts'
import { buildRoadmapExport } from '../services/roadmap-export.ts'
import { ROADMAP_EXPORT_FORMATS, type RoadmapExportProject } from '@shared/roadmap/export.ts'
import {
  abortRoadmapReview,
  completeRoadmapReview,
  prepareRoadmapReview,
  readRoadmapReviewCheckpointForRenderer,
  reviewRoadmapItem,
  reviewRoadmapItemDeep,
} from '../services/roadmap-review.ts'

/**
 * The project `roadmap:export` names in its header. Named from the same scope
 * `buildRoadmapExport` loads the notes from, so the header can never describe a
 * different project than the items. Both move to the asking window's project
 * together with the knowledge store (#3958).
 */
export function roadmapExportProject(): RoadmapExportProject {
  const { projectId } = currentProjectStoreScope()
  const project = projectId ? getProjectById(projectId) : null
  if (!project) {
    throw new IpcValidationError('No active project to export a roadmap for.')
  }
  return project
}

export function registerRoadmapHandlers(win: BrowserWindow): void {
  // Roadmap pane (issue #556; #645 Phase 3). Reads and edits the `Roadmap` notes
  // the agent's roadmap_plan tool authors: the prompt is the note body with the
  // title derived from it (roadmapTitleFromPrompt), waiting-on context lives in a
  // `notes` frontmatter field, an optional pinned GitHub issue in an `issue`
  // field (canonical short ref, see issue-ref.ts), and the lifecycle status is
  // one of ROADMAP_STATUSES. Update/delete verify the note's type so this
  // surface can never mutate Memory (or other) knowledge notes.
  const zRoadmapIssue = z.string().max(256)
  const zRoadmapStatus = z.enum(ROADMAP_STATUSES)
  const zRoadmapId = zNonEmptyString.max(128)
  const zRoadmapCategory = z.union([z.literal(''), z.enum(ROADMAP_CATEGORIES)])
  const zRoadmapExportFormat = z.enum(ROADMAP_EXPORT_FORMATS)

  ipcMain.handle('roadmap:list', (event) => {
    assertMainFrameSender(event, win)
    return loadKnowledgeNotes(ROADMAP_TYPE)
  })

  const roadmapWrites = createRoadmapWriteHandlers({
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
  })
  ipcMain.handle('roadmap:create', (event, ...args: Parameters<typeof roadmapWrites.create>) => {
    assertMainFrameSender(event, win)
    return roadmapWrites.create(...args)
  })
  ipcMain.handle('roadmap:update', (event, ...args: Parameters<typeof roadmapWrites.update>) => {
    assertMainFrameSender(event, win)
    return roadmapWrites.update(...args)
  })

  // An attachment's payload as a data URL, fetched lazily for thumbnails and
  // for carrying attachments into a new thread's composer.
  ipcMain.handle('roadmap:attachment-data', (event, rawId: unknown, rawAttachmentId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zRoadmapId, [rawId])
    const attachmentId = parseIpcArgs(zNonEmptyString.max(128), [rawAttachmentId])
    const note = getKnowledgeNote(id)
    if (!note || note.type !== ROADMAP_TYPE) return null
    const att = parseKnowledgeAttachments(note.fields[ATTACHMENTS_FIELD]).find(
      (a) => a.id === attachmentId,
    )
    return att ? readKnowledgeAttachmentDataUrl(id, att) : null
  })

  // Status-only flip (row-level mark-done/reopen, and review triage). Mirrors
  // the roadmap_plan tool's set_status action: no prompt/notes/issue
  // round-trip, so complexity is never re-classified. Re-reading the store
  // avoids overwriting a prompt/notes edit made while a model review ran.
  ipcMain.handle('roadmap:set-status', (event, rawId: unknown, rawStatus: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zRoadmapId, [rawId])
    const status = parseIpcArgs(zRoadmapStatus, [rawStatus])
    const existing = getKnowledgeNote(id)
    if (!existing || existing.type !== ROADMAP_TYPE) return null
    return setKnowledgeNoteStatus(id, status)
  })

  // User-chosen category override. A category word pins the `category` field
  // and marks it `categoryManual`, so a later prompt-change re-classification
  // does not overwrite the user's pick (see stampRoadmapCategory).
  //
  // The empty string is the editor's "Auto": it unpins by clearing both fields
  // and re-runs the classifier in the background against the item's current
  // prompt. Without that round-trip "Auto" would only ever mean "no category
  // until I next edit the prompt", since the update path stamps on a prompt
  // change alone. The schema admits '' or a category word and nothing else, so
  // the two branches below are total.
  ipcMain.handle('roadmap:set-category', (event, rawId: unknown, rawCategory: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zRoadmapId, [rawId])
    const input = parseIpcArgs(zRoadmapCategory.optional(), [rawCategory]) ?? ''
    const existing = getKnowledgeNote(id)
    if (!existing || existing.type !== ROADMAP_TYPE) return null
    const fields = { ...existing.fields }
    if (isRoadmapCategory(input)) {
      fields['category'] = input
      fields['categoryManual'] = '1'
    } else {
      delete fields['category']
      delete fields['categoryManual']
    }
    const updated = updateKnowledgeNote(id, { fields })
    if (updated && !isRoadmapCategory(input)) {
      void stampRoadmapCategory(id, updated.body, notifyRoadmapChanged)
    }
    return updated
  })

  // The roadmap's notes live in the knowledge store, which outside a turn
  // belongs to the active project (`currentProjectStoreScope`), not to the
  // asking window. Its git and GitHub evidence comes from that same project,
  // so a review, a fit check or an issue import never pairs one project's
  // repo with another's notes. Per-window roadmaps need a per-window
  // knowledge store first (#3958).
  const roadmapProjectRoot = (): string | null => currentProjectStoreScope().root

  // Resolve a stored issue ref to a URL at click time, so short `#123` refs
  // always follow the workspace's *current* origin remote.
  ipcMain.handle('roadmap:issue-url', async (event, rawRef: unknown) => {
    assertMainFrameSender(event, win)
    const ref = parseIpcArgs(zRoadmapIssue, [rawRef]).trim()
    return issueRefToUrl(ref, await getGithubRepoSlug(roadmapProjectRoot()))
  })

  // Import-from-issues flow: list the workspace's open issues, then turn the
  // selected ones into roadmap items (prompt drafted by the small-tasks model,
  // falling back to a template — see roadmap-issue-import.ts).
  const roadmapIssueSchema = z.object({
    number: z.number().int().positive(),
    title: z.string().max(512),
    body: z.string().max(20_000),
  })
  const roadmapIssuePageSize = 20

  ipcMain.handle('roadmap:open-issues', async (event, rawPage: unknown) => {
    assertMainFrameSender(event, win)
    const page = parseIpcArgs(z.number().int().positive(), [rawPage])
    // The backend impls return [] for "gh missing", "not authenticated", and
    // "no origin remote" alike — fine for the PR panel, which surfaces status
    // separately, but here an empty picker must mean "no open issues". Turn
    // the not-connected cases into real errors the picker can display.
    const root = roadmapProjectRoot()
    const backend = resolveGitHubBackend()
    const status = await backend.getStatus(root)
    if (!status.installed || !status.authenticated) {
      throw new Error(
        status.message ?? 'GitHub is not connected — sign in via `gh auth login` or a token.',
      )
    }
    const slug = await getGithubRepoSlug(root)
    if (!slug) {
      throw new Error('No GitHub origin remote detected in this workspace.')
    }
    // Return the slug too: an empty result names the repo it actually queried,
    // which surfaces stale/fork origins immediately. Pagination keeps every
    // GitHub/IPC/model operation bounded without imposing a repository-wide
    // issue ceiling on the picker.
    return {
      slug,
      ...(await backend.listWorkspaceOpenIssues(root, page, roadmapIssuePageSize)),
    }
  })

  const zRoadmapImportIssues = z.array(roadmapIssueSchema).max(roadmapIssuePageSize)

  ipcMain.handle('roadmap:import-issues', (event, rawIssues: unknown) => {
    assertMainFrameSender(event, win)
    const issues = parseIpcArgs(zRoadmapImportIssues, [rawIssues])
    return importIssuesAsRoadmapItems(issues, undefined, undefined, undefined, notifyRoadmapChanged)
  })

  // Semantic coverage for the import picker: which open issues already have a
  // roadmap prompt (even without a pin)? Pin matches stay client-side; this
  // only asks the small-tasks model about the unpinned remainder.
  ipcMain.handle('roadmap:match-open-issues', async (event, rawIssues: unknown) => {
    assertMainFrameSender(event, win)
    const issues = parseIpcArgs(zRoadmapImportIssues, [rawIssues])
    return matchOpenIssuesToRoadmapItems(issues)
  })

  // Thread tracking for "Start thread" and its reverse lookup for the
  // thread-side back-link chip (#2501); see roadmap-write-handlers.ts.
  ipcMain.handle('roadmap:set-thread', (event, rawId: unknown, rawThreadId: unknown) => {
    assertMainFrameSender(event, win)
    return roadmapWrites.setThread(rawId, rawThreadId)
  })
  ipcMain.handle('roadmap:find-by-thread', (event, rawThreadId: unknown) => {
    assertMainFrameSender(event, win)
    return roadmapWrites.findByThread(rawThreadId)
  })

  // Advisory fit check of an item's prompt against its pinned issue,
  // explicitly triggered from the pane (see roadmap-fit-check.ts).
  ipcMain.handle('roadmap:check-fit', (event, rawId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zRoadmapId, [rawId])
    return checkRoadmapFit(roadmapProjectRoot(), id)
  })

  ipcMain.handle('roadmap:prepare-review', (event) => {
    assertMainFrameSender(event, win)
    return prepareRoadmapReview(roadmapProjectRoot())
  })

  ipcMain.handle('roadmap:last-review-at', (event) => {
    assertMainFrameSender(event, win)
    return readRoadmapReviewCheckpointForRenderer()
  })

  ipcMain.handle(
    'roadmap:review-item',
    async (event, rawId: unknown, rawCommits: unknown, rawRunId: unknown) => {
      assertMainFrameSender(event, win)
      const id = parseIpcArgs(zRoadmapId, [rawId])
      const commits = parseIpcArgs(z.string().max(20_000), [rawCommits])
      const bulkRunId =
        rawRunId === undefined || rawRunId === null ? undefined : parseIpcArgs(z.uuid(), [rawRunId])
      const result = await reviewRoadmapItem(roadmapProjectRoot(), id, commits, 'bulk', bulkRunId)
      notifyRoadmapChanged()
      return result
    },
  )

  ipcMain.handle('roadmap:review-item-deep', async (event, rawId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zRoadmapId, [rawId])
    const result = await reviewRoadmapItemDeep(roadmapProjectRoot(), id)
    notifyRoadmapChanged()
    return result
  })

  ipcMain.handle('roadmap:complete-review', (event, rawRunId: unknown) => {
    assertMainFrameSender(event, win)
    const runId = parseIpcArgs(z.uuid(), [rawRunId])
    const completed = completeRoadmapReview(runId)
    notifyRoadmapChanged()
    return completed
  })

  ipcMain.handle('roadmap:abort-review', (event, rawRunId: unknown) => {
    assertMainFrameSender(event, win)
    const runId = parseIpcArgs(z.uuid(), [rawRunId])
    const aborted = abortRoadmapReview(runId)
    notifyRoadmapChanged()
    return aborted
  })

  ipcMain.handle('roadmap:delete', (event, rawId: unknown) => {
    assertMainFrameSender(event, win)
    return roadmapWrites.remove(rawId)
  })

  // Deterministic export of the active project's roadmap (RoadmapExporter,
  // shared/roadmap/export.ts) as a downloadable md/html/mhtml/jsonl document —
  // zipped with its attachments under relative paths when any are present.
  ipcMain.handle('roadmap:export', (event, rawFormat: unknown) => {
    assertMainFrameSender(event, win)
    const format = parseIpcArgs(zRoadmapExportFormat, [rawFormat])
    const result = buildRoadmapExport(roadmapExportProject(), format, new Date().toISOString())
    return {
      filename: result.filename,
      mimeType: result.mimeType,
      dataUrl: `data:${result.mimeType};base64,${Buffer.from(result.data).toString('base64')}`,
      bundled: result.bundled,
      files: result.files,
    }
  })
}
