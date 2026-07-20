import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import micromatch from 'micromatch'
import { createPanePopoutWindow } from '../windows/create-popout-window.ts'
import {
  assertAllowedWorkspaceRoot,
  getActiveProjectSshHost,
  getWorkspaceRoot,
  registerAllowedWorkspaceRoot,
  resolveSshHostForWorkspaceRoot,
  resolveWorkspacePath,
  scheduleAllowedWorkspaceRootsBootstrap,
  seedAllowedWorkspaceRoots,
  setWorkspaceRoot,
  type WorkspaceProjectRef,
} from '../services/workspace.ts'
import {
  assertFsWriteContent,
  isIndexQueryPattern,
  assertMainFrameSender,
  assertStorageKey,
  IpcValidationError,
  keyProviderSchema,
  setKeyOptionsSchema,
  parseIpcArgs,
  zMcpServerName,
  zHookTestRequest,
  zNonEmptyString,
  zPathString,
  zProjectId,
} from './ipc-guards.ts'
import { getIndex, whenFileIndexReady } from '../services/search/file-index.ts'
import { resolveFileReferences } from '../services/search/file-reference-resolver.ts'
import {
  getWorkspaceIndexStatus,
  onWorkspaceIndexStatusChanged,
} from '../services/search/index-status.ts'
import { startWorkspaceIndexing } from '../services/search/workspace-indexing.ts'
import { scheduleIndexRebuild } from '../services/search/workspace-index-watcher.ts'
import {
  getSetting,
  setSetting,
  hasApiKey,
  setApiKey,
  isApiKeyEncrypted,
} from '../services/storage/settings.ts'
import { scanEnvForKeys, maskSecret } from '../services/providers/env-key-detection.ts'
import {
  isRendererWritableSettingKey,
  isSecretSettingKey,
  parseRendererWritableSetting,
  securitySettingsSchema,
} from '../services/storage/settings-writable.ts'
import { storedExtraProviderSchema } from '../services/storage/settings-schema.ts'
import { migrateApprovedProviderHosts } from '../services/providers/approved-provider-hosts.ts'
import {
  getResolvedExtraProviders,
  saveExtraProvider,
  deleteExtraProvider,
  refreshHuggingFaceModels,
  HUGGINGFACE_SLUG,
} from '../services/providers/extra-providers-store.ts'
import { fetchOpenAiCompatibleModelsForSettings } from '../services/providers/provider-models.ts'
import { evaluateChatDefaultContext } from '../services/providers/chat-default-context.ts'
import { storageGet, storageSet } from '../services/storage/storage.ts'
import {
  loadProjectThreads,
  createThread,
  appendMessage,
  updateMeta,
  deleteProjectThread,
  loadProjectCatalog,
} from '../services/thread-store.ts'
import { detectAcpAgents } from '../services/acp/acp-detect.ts'
import { KNOWN_ACP_AGENTS } from '@shared/acp-known-agents.ts'
import {
  listExternalEditors,
  openWorkspaceInExternalEditor,
} from '../services/editors/editor-launcher.ts'
import { probeAcpAgentForSettings } from '../services/acp/acp-agent-service.ts'
import {
  requestAcpPackageInstallApproval,
  runAcpAutoSetup,
} from '../services/acp/acp-auto-setup.ts'
import { requestSshPrompt } from '../services/ssh-workspace/ssh-prompt.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'
import { listSkills, initSkillsRegistry } from '../services/skills/skills-registry.ts'
import { listCursorPlugins } from '../services/skills/cursor-plugins.ts'
import { listCursorHooksForSources } from '../services/hooks/cursor-adapter.ts'
import { listClaudeHooks } from '../services/hooks/claude-adapter.ts'
import {
  listCopseHooksForSources,
  listUnsandboxedProjectHooks,
} from '../services/hooks/copse-adapter.ts'
import { dryRunHook } from '../services/hooks/dry-run.ts'
import { getPackService } from '../services/packs/pack-service.ts'
import { loadProjectInstructionSources } from '../services/project-instructions.ts'
import {
  registerSkillTools,
  syncOkfMemoryTools,
  syncPiiTools,
  syncReadTerminalTools,
  syncRoadmapPlanTools,
} from '../services/registry-bootstrap.ts'
import { PII_REDACTION_ENABLED_SETTING } from '../services/security/pii-redactor.ts'
import { READ_TERMINAL_ENABLED_SETTING } from '@shared/terminal/read-terminal.ts'
import {
  OKF_MEMORIES_ENABLED_SETTING,
  MEMORY_TYPE,
  migrateLegacyMemories,
} from '../tools/memory-tools.ts'
import {
  ROADMAP_PLANS_ENABLED_SETTING,
  ROADMAP_STATUSES,
  ROADMAP_TYPE,
  roadmapTitleFromPrompt,
} from '../tools/roadmap-tools.ts'
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
import {
  ATTACHMENTS_FIELD,
  MAX_NOTE_ATTACHMENTS,
  parseKnowledgeAttachments,
  serializeKnowledgeAttachments,
} from '@shared/knowledge/attachments.ts'
import {
  checkoutGitBranch,
  getBranches,
  getDefaultBranch,
  getGitChangeStats,
  getGitFileDiff,
  getGitStatus,
  getGitWorkingFileDiff,
  getGithubRepoSlug,
  isInsideGitWorkTree,
} from '../services/github/git-service.ts'
import { parseIssueRef, issueRefToUrl } from '@shared/git/issue-ref.ts'
import { resolveGitHubBackend } from '../services/github/backend/backend.ts'
import { importIssuesAsRoadmapItems } from '../services/roadmap-issue-import.ts'
import { stampRoadmapComplexity } from '../services/roadmap-complexity.ts'
import { checkRoadmapFit } from '../services/roadmap-fit-check.ts'
import { getGitBranchStatus } from '../services/github/pr-context-service.ts'
import { getSessionBackup, restoreSessionBackup } from '../services/worktree-backup.ts'
import { isGitAvailableForTarget } from '../services/tool-availability.ts'
import {
  getGhCliStatus,
  getGhPrChecksState,
  getGhPrDetails,
  getGhPrFileDiff,
  listMyOpenPrs,
  listWorkspaceOpenPrs,
  resolveGithubPrRef,
} from '../services/github/gh-pr-service.ts'
import {
  approvePr,
  enablePrAutoMerge,
  markPrReady,
  rerunFailedPrRuns,
} from '../services/github/gh-pr-actions-service.ts'
import {
  getMcpServerStatuses,
  reloadMcpServers,
  setMcpServerUserEnabled,
  setWorkspaceTrustAndReload,
} from '../services/mcp/mcp-registry.ts'
import { getCuratedServerStatuses, setCuratedServerEnabled } from '../services/mcp/mcp-curated.ts'
import { isWorkspaceTrusted } from '../services/security/workspace-trust.ts'
import {
  setMockScript,
  clearMockScript,
  mockScriptCursorForTests,
  type MockScriptStep,
} from '@copse/llm/mock-script.ts'
import { applyAppIcon } from '../app-icon.ts'
import {
  getMainWindow,
  registerDevtoolsShortcut,
  unregisterDevtoolsShortcut,
} from '../windows/create-main-window.ts'
import { validateApiKey } from '../services/providers/validate-api-key.ts'
import {
  invalidateProviderKeyStatus,
  isProviderKeyUsable,
  recordProviderKeyValidation,
} from '../services/providers/provider-key-status.ts'
import { getUsageSummary, recordUsageEvent } from '../services/storage/usage-ledger.ts'
import { parseUsageRecordInput } from '../services/storage/usage-record-schema.ts'
import { loadPlanUsageSnapshot } from '../services/plan-usage-bridge.ts'
import {
  fetchLiveIntellectModels,
  invalidateLiveIntellectCache,
} from '../services/providers/aa-live-intellect.ts'
import {
  fetchRemoteArtifactImageDataUrl,
  resolveRemoteArtifactDownloadUrl,
} from '../services/remote/remote-agent-client.ts'
import {
  invalidateCursorCloudModelsCache,
  listCursorCloudModels,
} from '../services/remote/cursor-cloud-models.ts'
import { listActiveProjectAgentPrLinks } from '../services/remote/remote-agent-link-store.ts'
import {
  gatewayListDir,
  gatewayReadFile,
  gatewayReaddir,
  gatewayWriteFile,
} from '../project-sandbox/sandbox-fs-client.ts'

const SKILLS_RELOAD_KEYS = new Set([
  'skillsEnabled',
  'bundledCursorSkillsEnabled',
  'skillPluginPaths',
])

export function registerAllHandlers(win: BrowserWindow, registry: ToolRegistry): void {
  // Issue #438: persist grandfathered custom-provider hosts once so Settings
  // and runtime gates share the same allowlist after upgrade.
  void migrateApprovedProviderHosts()
  const storedProjects = (storageGet('projects') as WorkspaceProjectRef[] | null) ?? []
  scheduleAllowedWorkspaceRootsBootstrap(async () => {
    await seedAllowedWorkspaceRoots(storedProjects)
    const persistedRoot = getWorkspaceRoot()
    if (persistedRoot) {
      const sshHost = getActiveProjectSshHost()
      try {
        await registerAllowedWorkspaceRoot(persistedRoot, sshHost)
      } catch {
        // Stale workspaceRoot in config — ignore until user picks a folder.
      }
    }
  })

  ipcMain.handle('workspace:open', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    const root = await registerAllowedWorkspaceRoot(result.filePaths[0])
    setWorkspaceRoot(root)
    // Scheduled, not awaited — index builds must not block the renderer's
    // swap to the full layout; the footer indicator reports progress.
    startWorkspaceIndexing(root)
    await initSkillsRegistry()
    registerSkillTools(registry)
    return root
  })

  ipcMain.handle('workspace:get', () => getWorkspaceRoot())

  ipcMain.handle('workspace:set', async (event, root: unknown, sshHostArg?: unknown) => {
    assertMainFrameSender(event, win)
    const parsedRoot = parseIpcArgs(zPathString, [root])
    const explicitSshHost = parseIpcArgs(z.string().max(128).optional(), [sshHostArg])
    const projects = (storageGet('projects') as WorkspaceProjectRef[] | null) ?? []
    await seedAllowedWorkspaceRoots(projects)
    const sshHost = resolveSshHostForWorkspaceRoot(parsedRoot, explicitSshHost)
    const canonical = await assertAllowedWorkspaceRoot(parsedRoot, sshHost)
    setWorkspaceRoot(canonical)
    startWorkspaceIndexing(canonical)
    // Do NOT block the IPC response (and therefore the renderer's boot / first
    // paint) on the skills scan. It re-scans user + bundled + workspace skill
    // roots and, when the workspace index build is churning the event loop, can
    // take many seconds — which left the UI stuck on "loading" because
    // `api.workspace.set` never returned. Populate skills in the background and
    // register their tools when ready; the window renders immediately.
    void initSkillsRegistry()
      .then(() => {
        registerSkillTools(registry)
      })
      .catch((err: unknown) => {
        console.warn('[skills] background init failed:', err)
      })
    return canonical
  })

  ipcMain.handle('fs:readFile', async (event, path: unknown) => {
    assertMainFrameSender(event, win)
    const relPath = parseIpcArgs(zPathString, [path])
    const abs = await resolveWorkspacePath(relPath)
    return gatewayReadFile(abs)
  })

  ipcMain.handle('fs:writeFile', async (event, path: unknown, content: unknown) => {
    assertMainFrameSender(event, win)
    const relPath = parseIpcArgs(zPathString, [path])
    if (typeof content !== 'string') throw new IpcValidationError('File content must be a string')
    assertFsWriteContent(content)
    const abs = await resolveWorkspacePath(relPath)
    await gatewayWriteFile(abs, content)
    scheduleIndexRebuild()
  })

  ipcMain.handle('fs:readdir', async (event, path: unknown) => {
    assertMainFrameSender(event, win)
    const relPath = parseIpcArgs(zPathString, [path])
    const abs = await resolveWorkspacePath(relPath)
    return gatewayReaddir(abs)
  })

  ipcMain.handle('fs:listDir', async (event, path: unknown) => {
    assertMainFrameSender(event, win)
    const relPath = parseIpcArgs(zPathString.optional(), [path])
    const abs = await resolveWorkspacePath(relPath || '.')
    const dirents = await gatewayListDir(abs)
    return dirents
      .filter((d) => !d.name.startsWith('.') && d.name !== 'node_modules')
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  })

  ipcMain.handle('index:query', async (event, pattern: unknown) => {
    assertMainFrameSender(event, win)
    if (pattern !== undefined && typeof pattern !== 'string') {
      throw new IpcValidationError('Index query pattern must be a string')
    }
    const query = typeof pattern === 'string' ? pattern : ''
    if (query && !isIndexQueryPattern(query)) return []
    await whenFileIndexReady()
    const idx = getIndex()
    if (!idx) return []
    return query ? micromatch(idx.paths, `**/*${query}*`).slice(0, 20) : idx.paths.slice(0, 20)
  })

  ipcMain.handle('index:status', (event) => {
    assertMainFrameSender(event, win)
    return getWorkspaceIndexStatus()
  })

  onWorkspaceIndexStatusChanged((status) => {
    if (!win.isDestroyed()) win.webContents.send('index:status_changed', status)
  })

  ipcMain.handle('index:resolveFileReferences', async (event, rawCandidates: unknown) => {
    assertMainFrameSender(event, win)
    const candidates = parseIpcArgs(z.array(z.string().min(1).max(4096)).max(200), [rawCandidates])
    await whenFileIndexReady()
    return await resolveFileReferences(candidates)
  })

  // OKF memories management. The renderer's Memories pane (issue #645, Phase 3)
  // reads and edits the `Memory` notes the agent's remember/recall tools author.
  // Only the Memory type is exposed; roadmap/other knowledge types stay internal.
  const zMemoryTitle = z.string().max(512)
  const zMemoryBody = z.string().max(1_000_000)
  const zMemoryTags = z.array(z.string().max(128)).max(64)

  ipcMain.handle('memories:list', (event) => {
    assertMainFrameSender(event, win)
    // Fold in any pre-#645 notes on first read so the pane matches `recall`.
    migrateLegacyMemories()
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
      return updateKnowledgeNote(id, { title, body, tags })
    },
  )

  ipcMain.handle('memories:delete', (event, rawId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zNonEmptyString.max(128), [rawId])
    return deleteKnowledgeNote(id)
  })

  // Roadmap pane (issue #556; #645 Phase 3). Reads and edits the `Roadmap` notes
  // the agent's roadmap_plan tool authors: the prompt is the note body with the
  // title derived from it (roadmapTitleFromPrompt), waiting-on context lives in a
  // `notes` frontmatter field, an optional pinned GitHub issue in an `issue`
  // field (canonical short ref, see issue-ref.ts), and the lifecycle status is
  // one of ROADMAP_STATUSES. Update/delete verify the note's type so this
  // surface can never mutate Memory (or other) knowledge notes.
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

  // Complexity stamps land after the save returns (stampRoadmapComplexity), so
  // tell the panes when one arrives rather than making them poll. Broadcast to
  // every window: the roadmap pane may live in a detached pop-out with its own
  // renderer, not just the main window.
  const notifyRoadmapChanged = (): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('roadmap:changed')
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

  ipcMain.handle('roadmap:list', (event) => {
    assertMainFrameSender(event, win)
    return loadKnowledgeNotes(ROADMAP_TYPE)
  })

  ipcMain.handle(
    'roadmap:create',
    (event, rawPrompt: unknown, rawNotes: unknown, rawIssue: unknown, rawAttachments: unknown) => {
      assertMainFrameSender(event, win)
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
      // Saving is immediate; the complexity classification (a model round-trip)
      // stamps the note in the background and the pane refreshes on the event.
      void stampRoadmapComplexity(note.id, prompt, notifyRoadmapChanged)
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
    },
  )

  ipcMain.handle(
    'roadmap:update',
    (
      event,
      rawId: unknown,
      rawPrompt: unknown,
      rawNotes: unknown,
      rawStatus: unknown,
      rawIssue: unknown,
      rawAddAttachments: unknown,
      rawRemoveAttachmentIds: unknown,
    ) => {
      assertMainFrameSender(event, win)
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
      // A stored fit verdict judges a specific prompt/issue pair; either side
      // changing invalidates it (and its reasoning).
      if (promptChanged || issue !== (existing.fields['issue'] ?? '')) {
        delete fields['fit']
        delete fields['fitDetail']
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
      if (updated && promptChanged) {
        void stampRoadmapComplexity(id, prompt, notifyRoadmapChanged)
      }
      return updated
    },
  )

  // An attachment's payload as a data URL, fetched lazily for thumbnails and
  // for carrying attachments into a new thread's composer.
  ipcMain.handle('roadmap:attachmentData', (event, rawId: unknown, rawAttachmentId: unknown) => {
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

  // Status-only flip (the pane's row-level mark-done/reopen toggle). Mirrors
  // the roadmap_plan tool's set_status action: no prompt/notes/issue
  // round-trip, so the stored complexity is never re-classified.
  ipcMain.handle('roadmap:setStatus', (event, rawId: unknown, rawStatus: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zRoadmapId, [rawId])
    const status = parseIpcArgs(zRoadmapStatus, [rawStatus])
    const existing = getKnowledgeNote(id)
    if (!existing || existing.type !== ROADMAP_TYPE) return null
    return setKnowledgeNoteStatus(id, status)
  })

  // Resolve a stored issue ref to a URL at click time, so short `#123` refs
  // always follow the workspace's *current* origin remote.
  ipcMain.handle('roadmap:issueUrl', async (event, rawRef: unknown) => {
    assertMainFrameSender(event, win)
    const ref = parseIpcArgs(zRoadmapIssue, [rawRef]).trim()
    return issueRefToUrl(ref, await getGithubRepoSlug())
  })

  // Import-from-issues flow: list the workspace's open issues, then turn the
  // selected ones into roadmap items (prompt drafted by the small-tasks model,
  // falling back to a template — see roadmap-issue-import.ts).
  ipcMain.handle('roadmap:openIssues', async (event) => {
    assertMainFrameSender(event, win)
    // The backend impls return [] for "gh missing", "not authenticated", and
    // "no origin remote" alike — fine for the PR panel, which surfaces status
    // separately, but here an empty picker must mean "no open issues". Turn
    // the not-connected cases into real errors the picker can display.
    const backend = resolveGitHubBackend()
    const status = await backend.getStatus()
    if (!status.installed || !status.authenticated) {
      throw new Error(
        status.message ?? 'GitHub is not connected — sign in via `gh auth login` or a token.',
      )
    }
    const slug = await getGithubRepoSlug()
    if (!slug) {
      throw new Error('No GitHub origin remote detected in this workspace.')
    }
    // Return the slug too: an empty result names the repo it actually queried,
    // which surfaces stale/fork origins immediately. Limit 30: even with
    // per-issue bodies bounded at the backend, the gh CLI path must stay
    // comfortably under runCommand's 100 KiB stdout cap.
    return { slug, issues: await backend.listWorkspaceOpenIssues(30) }
  })

  const zRoadmapImportIssues = z
    .array(
      z.object({
        number: z.number().int().positive(),
        title: z.string().max(512),
        body: z.string().max(20_000),
      }),
    )
    .max(20)

  ipcMain.handle('roadmap:importIssues', (event, rawIssues: unknown) => {
    assertMainFrameSender(event, win)
    const issues = parseIpcArgs(zRoadmapImportIssues, [rawIssues])
    return importIssuesAsRoadmapItems(issues, undefined, undefined, notifyRoadmapChanged)
  })

  // Advisory fit check of an item's prompt against its pinned issue,
  // explicitly triggered from the pane (see roadmap-fit-check.ts).
  ipcMain.handle('roadmap:checkFit', (event, rawId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zRoadmapId, [rawId])
    return checkRoadmapFit(id)
  })

  ipcMain.handle('roadmap:delete', (event, rawId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zRoadmapId, [rawId])
    const existing = getKnowledgeNote(id)
    if (!existing || existing.type !== ROADMAP_TYPE) return false
    const deleted = deleteKnowledgeNote(id)
    if (deleted) deleteAllKnowledgeAttachments(id)
    return deleted
  })

  ipcMain.handle('settings:get', (event, key: unknown) => {
    assertMainFrameSender(event, win)
    const k = parseIpcArgs(zNonEmptyString.max(128), [key])
    // Never hand stored API-key records back to the renderer — it only needs the
    // boolean `settings:getKey`. Reading `apiKey.*` here would expose the key
    // (base64 plaintext when the OS keyring is unavailable).
    if (isSecretSettingKey(k)) {
      throw new IpcValidationError(`Setting key not readable from renderer: ${k}`)
    }
    return getSetting(k, null)
  })
  ipcMain.handle('settings:set', async (event, key: unknown, value: unknown) => {
    assertMainFrameSender(event, win)
    const k = parseIpcArgs(zNonEmptyString.max(128), [key])
    if (!isRendererWritableSettingKey(k)) {
      throw new IpcValidationError(`Setting key not writable from renderer: ${k}`)
    }
    await setSetting(k, parseRendererWritableSetting(k, value))
    if (SKILLS_RELOAD_KEYS.has(k)) {
      await initSkillsRegistry()
      registerSkillTools(registry)
    }
    // Toggling the experimental OKF memories feature adds/removes its tools on the
    // live registry so it takes effect without an app restart.
    if (k === OKF_MEMORIES_ENABLED_SETTING) {
      syncOkfMemoryTools(registry)
    }
    // Same for the experimental roadmap plans tool (the Roadmap pane shares
    // this flag, so enabling it there should arm the agent tool live too).
    if (k === ROADMAP_PLANS_ENABLED_SETTING) {
      syncRoadmapPlanTools(registry)
    }
    // Same for the experimental PII redaction reveal tool.
    if (k === PII_REDACTION_ENABLED_SETTING) {
      syncPiiTools(registry)
    }
    if (k === READ_TERMINAL_ENABLED_SETTING) {
      syncReadTerminalTools(registry)
    }
    // Toggle the DevTools shortcut registration when the setting changes.
    if (k === 'devtoolsShortcutEnabled') {
      const win = getMainWindow()
      const enabled = typeof value === 'boolean' && value
      if (enabled) {
        if (win) registerDevtoolsShortcut(win)
      } else {
        unregisterDevtoolsShortcut()
      }
    }
  })
  ipcMain.handle('settings:setSecurity', async (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    const prefs = securitySettingsSchema.parse(raw)
    await Promise.all(
      Object.entries(prefs)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => setSetting(k, v)),
    )
  })
  ipcMain.handle('settings:getKey', (event, provider: unknown) => {
    assertMainFrameSender(event, win)
    const p = parseIpcArgs(keyProviderSchema, [provider])
    return hasApiKey(p)
  })
  // Live Artificial Analysis feed for the model value map. Key-gated (empty
  // result without a stored 'artificial-analysis' key); the renderer's anchor
  // gate decides whether the returned cohort is on the canonical scale.
  ipcMain.handle('intellect:live-models', (event) => {
    assertMainFrameSender(event, win)
    return fetchLiveIntellectModels()
  })
  // At-rest state for a provider's stored key: true = OS-encrypted, false = base64
  // plaintext fallback, null = no key stored. Lets the Settings UI flag the
  // plaintext-at-rest condition instead of leaving it to a console.warn.
  ipcMain.handle('settings:getKeyEncrypted', (event, provider: unknown) => {
    assertMainFrameSender(event, win)
    const p = parseIpcArgs(keyProviderSchema, [provider])
    return isApiKeyEncrypted(p)
  })
  ipcMain.handle('settings:setKey', (event, provider: unknown, key: unknown, opts: unknown) => {
    assertMainFrameSender(event, win)
    const p = parseIpcArgs(keyProviderSchema, [provider])
    const apiKey = parseIpcArgs(z.string().max(8192), [key])
    const options = parseIpcArgs(setKeyOptionsSchema, [opts])
    const result = setApiKey(p, apiKey, options)
    // Encryption unavailable and no plaintext consent: nothing was stored. Report
    // back so the renderer can prompt for explicit consent and retry.
    if (!result.ok) return result
    invalidateProviderKeyStatus(p)
    if (p === 'cursor') invalidateCursorCloudModelsCache()
    // The live Intelligence Index feed caches its result (successes AND failures)
    // for hours, so a stored 403/empty would otherwise survive the user fixing
    // their key. Drop it here so the next value-map open re-fetches with the new
    // key.
    if (p === 'artificial-analysis') invalidateLiveIntellectCache()
    // Saving an HF token auto-populates its priced, provider-pinned model list so
    // the picker and cost estimate work without a manual fetch (fire-and-forget).
    if (p === HUGGINGFACE_SLUG && apiKey.trim()) {
      void refreshHuggingFaceModels(apiKey).catch(() => {})
    }
    return result
  })
  ipcMain.handle('settings:availableProviders', async () => {
    const available: Record<string, boolean> = {
      anthropic: await isProviderKeyUsable('anthropic'),
      openai: await isProviderKeyUsable('openai'),
      cursor: await isProviderKeyUsable('cursor'),
      openrouter: await isProviderKeyUsable('openrouter'),
    }
    for (const provider of getResolvedExtraProviders()) {
      // Local servers need no API key, so treat them as available; their models
      // only surface in the picker once the user fetches/saves them anyway.
      available[provider.id] = provider.local ? true : await isProviderKeyUsable(provider.id)
    }
    return available
  })
  ipcMain.handle('settings:validateKey', async (event, provider: unknown, key: unknown) => {
    assertMainFrameSender(event, win)
    const p = parseIpcArgs(keyProviderSchema, [provider])
    const apiKey = parseIpcArgs(z.string().max(8192), [key])
    const result = await validateApiKey(p, apiKey)
    recordProviderKeyValidation(p, result.ok)
    return result
  })
  // Opt-in environment scan: look for provider API keys the user already has
  // exported (process.env + well-known shell files) and offer to import them.
  // Raw secrets stay in the main process — the renderer only sees the masked
  // preview. Both handlers re-scan on each call; the import handler is gated on
  // the persisted consent flag set when the user approves the scan.
  ipcMain.handle('settings:scanEnvKeys', (event) => {
    assertMainFrameSender(event, win)
    return scanEnvForKeys().map((d) => ({
      provider: d.provider,
      envVar: d.envVar,
      source: d.source,
      masked: maskSecret(d.value),
      alreadyConfigured: hasApiKey(d.provider),
    }))
  })
  ipcMain.handle('settings:importEnvKeys', (event) => {
    assertMainFrameSender(event, win)
    if (!getSetting<boolean>('envKeyAutoDetectEnabled', false)) {
      throw new IpcValidationError('Environment key detection has not been enabled')
    }
    const imported: { provider: string; source: string }[] = []
    const skipped: { provider: string; reason: string }[] = []
    for (const d of scanEnvForKeys()) {
      // Never overwrite a key the user has already configured.
      if (hasApiKey(d.provider)) {
        skipped.push({ provider: d.provider, reason: 'already-configured' })
        continue
      }
      // Honour the plaintext gate here too: a bulk env import must not write keys
      // unencrypted without consent. Skipped rather than silently stored in clear.
      // The user can add the key manually via the Settings UI where the per-save
      // confirm dialog lets them approve plaintext storage explicitly.
      const result = setApiKey(d.provider, d.value)
      if (!result.ok) {
        skipped.push({ provider: d.provider, reason: 'plaintext-storage-refused' })
        continue
      }
      imported.push({ provider: d.provider, source: d.source })
    }
    return { imported, skipped }
  })
  ipcMain.handle('models:chatDefaultContextHealth', () => evaluateChatDefaultContext())
  ipcMain.handle('settings:extraProviders', () => getResolvedExtraProviders())
  ipcMain.handle('settings:saveExtraProvider', async (event, record: unknown) => {
    assertMainFrameSender(event, win)
    const parsed = parseIpcArgs(storedExtraProviderSchema.partial({ slug: true }), [record])
    return saveExtraProvider(parsed as Parameters<typeof saveExtraProvider>[0])
  })
  ipcMain.handle('settings:deleteExtraProvider', async (event, slug: unknown) => {
    assertMainFrameSender(event, win)
    const s = parseIpcArgs(keyProviderSchema, [slug])
    return deleteExtraProvider(s)
  })
  ipcMain.handle('settings:fetchProviderModels', async (event, baseUrl: unknown, key: unknown) => {
    assertMainFrameSender(event, win)
    const url = parseIpcArgs(z.string().max(2048), [baseUrl])
    const apiKey = parseIpcArgs(z.string().max(8192).optional(), [key])
    return fetchOpenAiCompatibleModelsForSettings(url, apiKey)
  })
  ipcMain.handle('settings:refreshHuggingFaceModels', async (event, key: unknown) => {
    assertMainFrameSender(event, win)
    const apiKey = parseIpcArgs(z.string().max(8192).optional(), [key])
    return refreshHuggingFaceModels(apiKey)
  })
  ipcMain.handle('app-icon:apply', () => {
    const mainWin = getMainWindow()
    applyAppIcon(mainWin && !mainWin.isDestroyed() ? [mainWin] : [])
  })
  ipcMain.handle('usage:record', (event, input: unknown) => {
    assertMainFrameSender(event, win)
    recordUsageEvent(parseUsageRecordInput(input))
  })
  ipcMain.handle('usage:getSummary', () => getUsageSummary())
  ipcMain.handle('usage:getPlanUsage', async () => loadPlanUsageSnapshot())
  ipcMain.handle('storage:get', (event, key: unknown) => {
    assertMainFrameSender(event, win)
    const k = parseIpcArgs(zNonEmptyString.max(256), [key])
    assertStorageKey(k)
    return storageGet(k)
  })
  ipcMain.handle('storage:set', (event, key: unknown, value: unknown) => {
    assertMainFrameSender(event, win)
    const k = parseIpcArgs(zNonEmptyString.max(256), [key])
    assertStorageKey(k)
    storageSet(k, value)
  })

  const zThreadId = zNonEmptyString.max(256)
  ipcMain.handle('threads:loadProject', (event, projectId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zProjectId, [projectId])
    return loadProjectThreads(id)
  })
  ipcMain.handle('threads:create', (event, projectId: unknown, thread: unknown) => {
    assertMainFrameSender(event, win)
    const [id, payload] = parseIpcArgs(z.tuple([zProjectId, z.record(z.string(), z.unknown())]), [
      projectId,
      thread,
    ])
    return createThread(id, payload as unknown as import('@shared/types').Thread)
  })
  ipcMain.handle(
    'threads:appendMessage',
    (event, projectId: unknown, threadId: unknown, message: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, payload] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.record(z.string(), z.unknown())]),
        [projectId, threadId, message],
      )
      return appendMessage(pid, tid, payload as unknown as import('@shared/types').Message)
    },
  )
  ipcMain.handle(
    'threads:updateMeta',
    (event, projectId: unknown, threadId: unknown, patch: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, payload] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.record(z.string(), z.unknown())]),
        [projectId, threadId, patch],
      )
      return updateMeta(pid, tid, payload)
    },
  )
  ipcMain.handle('threads:delete', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, tid] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return deleteProjectThread(pid, tid)
  })
  ipcMain.handle('threads:catalog', (event, projectId: unknown, query: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, q] = parseIpcArgs(z.tuple([zProjectId, z.string().max(512).optional()]), [
      projectId,
      query,
    ])
    return loadProjectCatalog(pid, q)
  })

  ipcMain.handle('skills:list', () => listSkills())
  ipcMain.handle('plugins:list', () => listCursorPlugins())
  ipcMain.handle('hooks:list', async () => {
    const root = getWorkspaceRoot()
    const opts = { workspaceRoot: root, projectTrusted: isWorkspaceTrusted(root) }
    const [cursor, claude, copse] = await Promise.all([
      listCursorHooksForSources(opts),
      listClaudeHooks(opts),
      listCopseHooksForSources(opts),
    ])
    return {
      hooks: [...cursor.hooks, ...claude.hooks, ...copse.hooks],
      warnings: [...cursor.warnings, ...claude.warnings, ...copse.warnings],
    }
  })
  ipcMain.handle('hooks:test', async (event, rawReq: unknown) => {
    assertMainFrameSender(event, win)
    // G2 dry-run tester: run one discovered hook once against a synthetic
    // payload and report stdin/stdout/stderr/exit/duration. `dryRunHook` is a
    // side-effect-free probe — it never records the spine, propagates session
    // env, or applies the outcome (see dry-run.ts). Validate the request shape
    // so a compromised renderer cannot pass an arbitrary command through here.
    const parsed = parseIpcArgs(zHookTestRequest, [rawReq])
    // Rebuild explicitly so an omitted `sandbox` stays omitted (not `undefined`)
    // under exactOptionalPropertyTypes.
    return dryRunHook({
      family: parsed.family,
      event: parsed.event,
      command: parsed.command,
      source: parsed.source,
      scope: parsed.scope,
      ...(parsed.sandbox !== undefined ? { sandbox: parsed.sandbox } : {}),
    })
  })
  // Pack registry list (P3 of docs/plans/hooks-and-feature-packs.md). The
  // Settings pack list ("about:addons") calls these to enumerate every
  // registered pack, toggle enablement atomically (P1 contract), and read /
  // write pack-scoped settings values under the manifest's declared schema.
  ipcMain.handle('packs:list', (event) => {
    assertMainFrameSender(event, win)
    return { packs: getPackService().list() }
  })
  ipcMain.handle('packs:setEnabled', async (event, rawId: unknown, rawEnabled: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zNonEmptyString.max(128), [rawId])
    const enabled = parseIpcArgs(z.boolean(), [rawEnabled])
    await getPackService().setEnabled(id, enabled)
    return { packs: getPackService().list() }
  })
  ipcMain.handle(
    'packs:setSetting',
    async (event, rawId: unknown, rawKey: unknown, rawValue: unknown) => {
      assertMainFrameSender(event, win)
      const id = parseIpcArgs(zNonEmptyString.max(128), [rawId])
      const key = parseIpcArgs(zNonEmptyString.max(128), [rawKey])
      // Pack-scoped setting values are declaratively-shaped by the manifest;
      // the renderer sends the primitive it read from the form. Cap to a sane
      // upper bound so a compromised renderer can't stuff arbitrary payloads.
      const value = parseIpcArgs(
        z.union([z.boolean(), z.number(), z.string().max(8192), z.null()]),
        [rawValue],
      )
      await getPackService().setSetting(id, key, value)
      return { packs: getPackService().list() }
    },
  )

  // Decision 7 / F3: the workspace-trust prompt surfaces project hooks that
  // declare `sandbox: false` at the consent moment. Read-only display parsing —
  // trust-independent by design (the whole point is showing this BEFORE trust).
  ipcMain.handle('hooks:unsandboxedProjectHooks', async () => {
    const root = getWorkspaceRoot()
    if (!root) return []
    return listUnsandboxedProjectHooks(root)
  })
  ipcMain.handle('instructions:list', async () =>
    (await loadProjectInstructionSources()).map(({ path, name, scope, content }) => ({
      path,
      name,
      scope,
      bytes: Buffer.byteLength(content, 'utf-8'),
    })),
  )

  ipcMain.handle(
    'git:isAvailable',
    async () => (await isGitAvailableForTarget()) && (await isInsideGitWorkTree()),
  )
  ipcMain.handle('git:status', () => getGitStatus())
  ipcMain.handle('git:changeStats', () => getGitChangeStats())
  ipcMain.handle('git:fileDiff', (event, path: unknown, staged: unknown) => {
    assertMainFrameSender(event, win)
    const filePath = parseIpcArgs(zPathString, [path])
    const isStaged = parseIpcArgs(z.boolean(), [staged])
    return getGitFileDiff(filePath, isStaged)
  })
  ipcMain.handle('git:workingFileDiff', (event, path: unknown) => {
    assertMainFrameSender(event, win)
    const filePath = parseIpcArgs(zPathString, [path])
    return getGitWorkingFileDiff(filePath)
  })
  ipcMain.handle('git:branchStatus', (event, forBranch: unknown) => {
    assertMainFrameSender(event, win)
    // Git-ref charset only, no leading dash: the branch reaches `gh pr list
    // --head <branch>` and must never be option-shaped (#580).
    const branch =
      forBranch === undefined
        ? undefined
        : parseIpcArgs(
            z
              .string()
              .max(256)
              .regex(/^[A-Za-z0-9_][A-Za-z0-9_\-./]*$/),
            [forBranch],
          )
    return getGitBranchStatus(branch)
  })
  ipcMain.handle('git:checkoutBranch', async (event, branch: unknown) => {
    assertMainFrameSender(event, win)
    const targetBranch = parseIpcArgs(z.string().min(1).max(256), [branch])
    await checkoutGitBranch(targetBranch)
  })
  ipcMain.handle('git:listBranches', () => getBranches())
  ipcMain.handle('git:getDefaultBranch', () => getDefaultBranch())
  ipcMain.handle('git:sessionBackup', () => getSessionBackup())
  ipcMain.handle('git:restoreBackup', async (event) => {
    assertMainFrameSender(event, win)
    return restoreSessionBackup()
  })

  ipcMain.handle('gh:status', () => getGhCliStatus())
  ipcMain.handle('gh:listMyOpenPrs', () => listMyOpenPrs())
  ipcMain.handle('gh:listWorkspaceOpenPrs', () => listWorkspaceOpenPrs())
  ipcMain.handle('gh:prChecks', (event, owner: unknown, repo: unknown, number: unknown) => {
    assertMainFrameSender(event, win)
    const parsedOwner = parseIpcArgs(z.string().min(1).max(128), [owner])
    const parsedRepo = parseIpcArgs(z.string().min(1).max(128), [repo])
    const parsedNumber = parseIpcArgs(z.number().int().positive(), [number])
    return getGhPrChecksState({ owner: parsedOwner, repo: parsedRepo, number: parsedNumber })
  })
  ipcMain.handle('gh:prDetails', (event, owner: unknown, repo: unknown, number: unknown) => {
    assertMainFrameSender(event, win)
    const parsedOwner = parseIpcArgs(z.string().min(1).max(128), [owner])
    const parsedRepo = parseIpcArgs(z.string().min(1).max(128), [repo])
    const parsedNumber = parseIpcArgs(z.number().int().positive(), [number])
    return getGhPrDetails({ owner: parsedOwner, repo: parsedRepo, number: parsedNumber })
  })
  ipcMain.handle(
    'gh:prFileDiff',
    (event, owner: unknown, repo: unknown, number: unknown, path: unknown) => {
      assertMainFrameSender(event, win)
      const parsedOwner = parseIpcArgs(z.string().min(1).max(128), [owner])
      const parsedRepo = parseIpcArgs(z.string().min(1).max(128), [repo])
      const parsedNumber = parseIpcArgs(z.number().int().positive(), [number])
      const parsedPath = parseIpcArgs(zPathString, [path])
      return getGhPrFileDiff(
        { owner: parsedOwner, repo: parsedRepo, number: parsedNumber },
        parsedPath,
      )
    },
  )
  ipcMain.handle('gh:resolvePrUrl', (event, url: unknown) => {
    assertMainFrameSender(event, win)
    const parsedUrl = parseIpcArgs(z.url().max(2048), [url])
    return resolveGithubPrRef(parsedUrl)
  })
  // Local-only: which PRs in the active project were opened by an agent this app
  // launched (issue #690, Q6). No network, no user input — reads the thread metas.
  ipcMain.handle('gh:agentPrLinks', () => listActiveProjectAgentPrLinks())
  // PR lifecycle write actions. Unlike the read handlers above, these mutate
  // GitHub state, so each asserts a main-frame sender before acting.
  const parsePrRef = (
    owner: unknown,
    repo: unknown,
    number: unknown,
  ): { owner: string; repo: string; number: number } => ({
    owner: parseIpcArgs(z.string().min(1).max(128), [owner]),
    repo: parseIpcArgs(z.string().min(1).max(128), [repo]),
    number: parseIpcArgs(z.number().int().positive(), [number]),
  })
  ipcMain.handle('gh:rerunFailedRuns', (event, owner: unknown, repo: unknown, number: unknown) => {
    assertMainFrameSender(event, win)
    return rerunFailedPrRuns(parsePrRef(owner, repo, number))
  })
  ipcMain.handle('gh:approvePr', (event, owner: unknown, repo: unknown, number: unknown) => {
    assertMainFrameSender(event, win)
    return approvePr(parsePrRef(owner, repo, number))
  })
  ipcMain.handle('gh:markPrReady', (event, owner: unknown, repo: unknown, number: unknown) => {
    assertMainFrameSender(event, win)
    return markPrReady(parsePrRef(owner, repo, number))
  })
  ipcMain.handle('gh:enableAutoMerge', (event, owner: unknown, repo: unknown, number: unknown) => {
    assertMainFrameSender(event, win)
    return enablePrAutoMerge(parsePrRef(owner, repo, number))
  })
  ipcMain.handle('remoteAgent:downloadArtifact', async (event, agentId: unknown, path: unknown) => {
    assertMainFrameSender(event, win)
    const parsedAgentId = parseIpcArgs(z.string().min(1).max(128), [agentId])
    const parsedPath = parseIpcArgs(z.string().min(1).max(4096), [path])
    return resolveRemoteArtifactDownloadUrl({ agentId: parsedAgentId, path: parsedPath })
  })
  ipcMain.handle(
    'remoteAgent:artifactImageDataUrl',
    async (event, agentId: unknown, path: unknown) => {
      assertMainFrameSender(event, win)
      const parsedAgentId = parseIpcArgs(z.string().min(1).max(128), [agentId])
      const parsedPath = parseIpcArgs(z.string().min(1).max(4096), [path])
      return fetchRemoteArtifactImageDataUrl({ agentId: parsedAgentId, path: parsedPath })
    },
  )
  ipcMain.handle('remoteAgent:models', (event) => {
    assertMainFrameSender(event, win)
    return listCursorCloudModels()
  })
  ipcMain.handle('acp:detectAgents', (event) => {
    assertMainFrameSender(event, win)
    return detectAcpAgents()
  })
  ipcMain.handle('acp:probeAgent', (event, agentId: unknown) => {
    assertMainFrameSender(event, win)
    if (typeof agentId !== 'string') throw new Error('acp:probeAgent requires an agent id')
    return probeAcpAgentForSettings(agentId)
  })
  ipcMain.handle('acp:autoSetup', (event) => {
    assertMainFrameSender(event, win)
    return runAcpAutoSetup(new AbortController().signal)
  })
  ipcMain.handle('shell:openExternal', (event, url: unknown) => {
    assertMainFrameSender(event, win)
    const href = parseIpcArgs(z.url().max(2048), [url])
    if (!href.startsWith('http://') && !href.startsWith('https://')) {
      throw new IpcValidationError('URL must be http or https')
    }
    return shell.openExternal(href)
  })

  ipcMain.handle('editors:list', (event) => {
    assertMainFrameSender(event, win)
    return listExternalEditors()
  })
  ipcMain.handle('editors:open', (event, editorId: unknown) => {
    assertMainFrameSender(event, win)
    // Only a known editor id crosses this boundary; the folder to open is the
    // main process's own workspace root, never renderer-supplied.
    const parsedId = parseIpcArgs(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), [editorId])
    const root = getWorkspaceRoot()
    if (!root) throw new IpcValidationError('No workspace open')
    return openWorkspaceInExternalEditor(parsedId, root)
  })

  ipcMain.handle('panes:popout', (event, mode: unknown) => {
    assertMainFrameSender(event, win)
    const parsed = parseIpcArgs(
      z.enum(['explorer', 'terminal', 'changes', 'prs', 'memories', 'roadmap', 'browser']),
      [mode],
    )
    createPanePopoutWindow(parsed)
  })

  ipcMain.handle('mcp:list', (event) => {
    assertMainFrameSender(event, win)
    return getMcpServerStatuses()
  })
  ipcMain.handle('mcp:reload', async (event) => {
    assertMainFrameSender(event, win)
    const statuses = await reloadMcpServers(registry)
    win.webContents.send('mcp:status_changed', statuses)
    return statuses
  })
  ipcMain.handle('mcp:setEnabled', async (event, name: unknown, enabled: unknown) => {
    assertMainFrameSender(event, win)
    const [parsedName, parsedEnabled] = parseIpcArgs(z.tuple([zMcpServerName, z.boolean()]), [
      name,
      enabled,
    ])
    await setMcpServerUserEnabled(parsedName, parsedEnabled)
    const statuses = await reloadMcpServers(registry)
    win.webContents.send('mcp:status_changed', statuses)
    return statuses
  })
  ipcMain.handle('mcp:listCurated', (event) => {
    assertMainFrameSender(event, win)
    return getCuratedServerStatuses(getMcpServerStatuses())
  })
  ipcMain.handle('mcp:setCuratedEnabled', async (event, name: unknown, enabled: unknown) => {
    assertMainFrameSender(event, win)
    const [parsedName, parsedEnabled] = parseIpcArgs(z.tuple([zMcpServerName, z.boolean()]), [
      name,
      enabled,
    ])
    await setCuratedServerEnabled(parsedName, parsedEnabled)
    const statuses = await reloadMcpServers(registry)
    win.webContents.send('mcp:status_changed', statuses)
    return getCuratedServerStatuses(statuses)
  })
  ipcMain.handle('workspace:isTrusted', () => isWorkspaceTrusted(getWorkspaceRoot()))
  ipcMain.handle('workspace:setTrusted', async (event, trusted: unknown) => {
    assertMainFrameSender(event, win)
    const root = getWorkspaceRoot()
    if (!root) throw new IpcValidationError('No workspace open')
    if (typeof trusted !== 'boolean') throw new IpcValidationError('trusted must be a boolean')
    // Spawning project MCP servers is the code-execution sink, so trusting a workspace
    // is a privileged action — only the main frame may request it (issue #100).
    const statuses = await setWorkspaceTrustAndReload(registry, root, trusted)
    win.webContents.send('mcp:status_changed', statuses)
    return statuses
  })

  // E2e-only: register an ordered mock script so specs can drive multi-turn flows
  // with natural-language prompts (see mock-script.ts). Not exposed in release UX.
  if (process.env['COPSE_E2E'] === '1') {
    const mockScriptStepSchema = z
      .object({
        when: z.string().min(1).max(500),
        tool: z
          .object({
            name: z.string().min(1).max(128),
            args: z.record(z.string(), z.unknown()),
          })
          .optional(),
        text: z.string().max(10_000).optional(),
      })
      .refine((step) => step.tool !== undefined || step.text !== undefined, {
        message: 'mock script step needs tool or text',
      })

    ipcMain.handle('test:setMockScript', (event, raw: unknown) => {
      assertMainFrameSender(event, win)
      const steps = parseIpcArgs(z.array(mockScriptStepSchema).max(32), [raw])
      setMockScript(steps as MockScriptStep[])
      return { steps: steps.length, cursor: mockScriptCursorForTests() }
    })
    ipcMain.handle('test:clearMockScript', (event) => {
      assertMainFrameSender(event, win)
      clearMockScript()
    })
    ipcMain.handle('test:requestSshPrompt', (event, prompt: unknown, kind: unknown) => {
      assertMainFrameSender(event, win)
      const [parsedPrompt, parsedKind] = parseIpcArgs(
        z.tuple([z.string().min(1).max(2_000), z.enum(['confirm', 'secret'])]),
        [prompt, kind],
      )
      return requestSshPrompt({ prompt: parsedPrompt, kind: parsedKind })
    })
    ipcMain.handle('test:requestAcpPackageInstallApproval', (event) => {
      assertMainFrameSender(event, win)
      const codex = KNOWN_ACP_AGENTS.find((agent) => agent.id === 'codex')
      if (!codex) throw new IpcValidationError('Codex ACP preset is missing')
      return requestAcpPackageInstallApproval([codex])
    })
  }
}
