import { BrowserWindow, dialog, ipcMain, shell, webContents, type WebContents } from 'electron'
import { z } from 'zod'
import { parseMessageValue, parseThreadValue } from '@shared/threads/thread-boundary.ts'
import micromatch from 'micromatch'
import { nonEmptyStringOr, recordArrayOrEmpty } from '@shared/unknown-value.ts'
import { createPanePopoutWindow } from '../windows/create-popout-window.ts'
import { getInAppBrowserSession } from '../windows/browser-web-contents.ts'
import {
  captureBrowserPageText,
  captureBrowserScreenshot,
} from '../services/browser/browser-share.ts'
import { takePopoutSeed } from '../services/popout-seed-store.ts'
import {
  assertAllowedWorkspaceRoot,
  getActiveProjectId,
  getActiveProjectSshHost,
  getProjectById,
  getWorkspaceRoot,
  registerAllowedWorkspaceRoot,
  resolvePathWithinRoot,
  resolveSshHostForWorkspaceRoot,
  scheduleAllowedWorkspaceRootsBootstrap,
  seedAllowedWorkspaceRoots,
  setWorkspaceRoot,
  type WorkspaceProjectRef,
} from '../services/workspace.ts'
import { exportDecisionLog, readDecisionLog } from '../services/security/decision-log-store.ts'
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
  zThreadId,
} from './ipc-guards.ts'
import { resolveThreadExecutionContext } from '../services/thread-execution-context.ts'
import { getIndex, whenFileIndexReady } from '../services/search/file-index.ts'
import { resolveFileReferences } from '../services/search/file-reference-resolver.ts'
import {
  getWorkspaceIndexStatus,
  onWorkspaceIndexStatusChanged,
  setSemanticIndexScaleGuarded,
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
import {
  getResolvedExtraProviders,
  saveExtraProvider,
  deleteExtraProvider,
  refreshHuggingFaceModels,
  HUGGINGFACE_SLUG,
} from '../services/providers/extra-providers-store.ts'
import { fetchOpenAiCompatibleModelsForSettings } from '../services/providers/provider-models.ts'
import { evaluateChatDefaultContext } from '../services/providers/chat-default-context.ts'
import { resolveBestValueChatModel } from '../services/providers/best-value-model.ts'
import { storageGet, storageSet } from '../services/storage/storage.ts'
import {
  loadProjectThreads,
  createThread,
  appendMessage,
  updateMeta,
  deleteProjectThread,
  loadProjectCatalog,
  listOrphanProjectStores,
} from '../services/thread-store.ts'
import { buildThreadArchive } from '../services/thread-archive.ts'
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
import { detectAcpAgents } from '../services/acp/acp-detect.ts'
import { KNOWN_ACP_AGENTS } from '@shared/acp-known-agents.ts'
import {
  listExternalEditors,
  openWorkspaceInExternalEditor,
} from '../services/editors/editor-launcher.ts'
import { probeAcpAgentForSettings } from '../services/acp/acp-agent-service.ts'
import {
  requestAcpPackageInstallApproval,
  revalidateStaleAcpModels,
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
import {
  setPackToolRuntimeController,
  ToolingPackToolRuntimeController,
} from '../services/packs/pack-tool-controller.ts'
import { createPackBrowserPanelService } from '../services/packs/pack-browser-panel.ts'
import { setPackBrowserService } from '../services/packs/pack-browser-service.ts'
import { discoverCursorRules, toCursorRuleSummaries } from '../services/skills/cursor-rules.ts'
import { loadProjectInstructionSources } from '../services/project-instructions.ts'
import {
  registerSkillTools,
  syncAdvisorStrategyTools,
  syncCiInvestigatorTools,
  syncLongHorizonTasksTools,
  syncModelComparisonTools,
  syncBackgroundTasksTools,
  syncOkfMemoryTools,
  syncParallelSearchTools,
  syncPiiTools,
  syncReadTerminalTools,
  syncRoadmapPlanTools,
} from '../services/registry-bootstrap.ts'
import { MODEL_COMPARISON_PACK_ID } from '@copse/agent/packs/model-comparison-pack.ts'
import { LONG_HORIZON_TASKS_PACK_ID } from '@copse/agent/packs/long-horizon-tasks-pack.ts'
import { ROADMAP_PLANS_PACK_ID } from '@copse/agent/packs/roadmap-plans-pack.ts'
import { ADVISOR_STRATEGY_PACK_ID } from '@copse/agent/packs/advisor-strategy-pack.ts'
import { OKF_MEMORIES_PACK_ID } from '@copse/agent/packs/okf-memories-pack.ts'
import { CI_INVESTIGATOR_PACK_ID } from '@copse/agent/packs/ci-investigator-pack.ts'
import { PII_REDACTION_PACK_ID } from '@copse/agent/packs/pii-redaction-pack.ts'
import { DEVTOOLS_SHORTCUT_PACK_ID } from '@copse/agent/packs/devtools-shortcut-pack.ts'
import { BACKGROUND_TASKS_PACK_ID } from '@copse/agent/packs/background-tasks-pack.ts'
import { PARALLEL_SEARCH_PACK_ID } from '@copse/agent/packs/parallel-search-pack.ts'
import { DARK_FACTORY_PACK_ID } from '@copse/agent/packs/dark-factory-pack.ts'
import { getAutomationService } from '../services/automations/automation-service.ts'
import { syncDarkFactorySensor } from '../services/supervisor/dark-factory-sensor.ts'
import { READ_TERMINAL_ENABLED_SETTING } from '@shared/terminal/read-terminal.ts'
import { MEMORY_TYPE } from '../tools/memory-tools.ts'
import { ROADMAP_STATUSES, ROADMAP_TYPE, roadmapTitleFromPrompt } from '../tools/roadmap-tools.ts'
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
import { matchOpenIssuesToRoadmapItems } from '../services/roadmap-issue-coverage.ts'
import { stampRoadmapComplexity } from '../services/roadmap-complexity.ts'
import { stampRoadmapCategory } from '../services/roadmap-category.ts'
import { checkRoadmapFit } from '../services/roadmap-fit-check.ts'
import { buildRoadmapExport } from '../services/roadmap-export.ts'
import { ROADMAP_EXPORT_FORMATS } from '@shared/roadmap/export.ts'
import {
  abortRoadmapReview,
  completeRoadmapReview,
  prepareRoadmapReview,
  readRoadmapReviewCheckpointForRenderer,
  reviewRoadmapItem,
  reviewRoadmapItemDeep,
} from '../services/roadmap-review.ts'
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
import { getMainWindow, syncDevtoolsShortcut } from '../windows/create-main-window.ts'
import { buildAppMenu } from '../windows/app-menu.ts'
import { DEVELOPER_MODE_SETTING } from '@shared/developer-mode.ts'
import { validateApiKey } from '../services/providers/validate-api-key.ts'
import {
  invalidateProviderKeyStatus,
  isProviderKeyUsable,
  recordProviderKeyValidation,
} from '../services/providers/provider-key-status.ts'
import { getUsageSummary, recordUsageEvent } from '../services/storage/usage-ledger.ts'
import { parseUsageRecordInput } from '../services/storage/usage-record-schema.ts'
import {
  getPlanWorthItPayload,
  loadPlanUsageSnapshotAndSample,
  setClaudePlanMonthlyFeeUsd,
} from '../services/storage/plan-window-history.ts'
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
import { discoverExternalCursorAgents } from '../services/remote/cursor-agent-discovery.ts'
import { listActiveProjectAgentPrLinks } from '../services/remote/remote-agent-link-store.ts'

import {
  gatewayListDir,
  gatewayReadFile,
  gatewayReaddir,
  gatewayWriteFile,
} from '../project-sandbox/sandbox-fs-client.ts'
import { requestApproval } from '../services/approval.ts'
import {
  armGuardedYolo,
  disableGuardedYolo,
  getGuardedYoloState,
  onGuardedYoloChanged,
} from '../services/security/guarded-yolo.ts'

const zAutomationScheduleInput = z.object({
  id: z.string().min(1).max(256).optional(),
  name: z.string().trim().min(1).max(160),
  cron: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(100_000),
  model: z.string().trim().min(1).max(1024),
  enabled: z.boolean(),
})

const SKILLS_RELOAD_KEYS = new Set([
  'skillsEnabled',
  'bundledCursorSkillsEnabled',
  'skillPluginPaths',
])

function storedWorkspaceProjects(): WorkspaceProjectRef[] {
  return recordArrayOrEmpty(storageGet('projects')).flatMap((project) => {
    const path = project['path']
    const sshHost = project['sshHost']
    if (typeof path !== 'string') return []
    return [typeof sshHost === 'string' ? { path, sshHost } : { path }]
  })
}

export function registerAllHandlers(win: BrowserWindow, registry: ToolRegistry): void {
  const packService = getPackService()
  setPackBrowserService(createPackBrowserPanelService(win))
  setPackToolRuntimeController(new ToolingPackToolRuntimeController(registry))
  void packService.refreshPackSources().catch((error: unknown) => {
    console.warn('[packs] selected-pack startup reconciliation failed:', error)
  })
  // Register the DevTools shortcut at boot iff the `copse.devtools-shortcut`
  // pack is enabled. The pack ships off (`defaultEnabled: false`) and
  // getPackService() has already layered the user's explicit choices on top, so
  // this is a no-op unless they opted in.
  syncDevtoolsShortcut(win)
  const stopGuardedYoloEvents = onGuardedYoloChanged((threadId) => {
    if (!win.isDestroyed()) {
      win.webContents.send('security:guardedYoloChanged', getGuardedYoloState(threadId))
    }
  })
  win.once('closed', stopGuardedYoloEvents)
  const storedProjects = storedWorkspaceProjects()
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

  function interactiveBrowserContents(
    event: Electron.IpcMainInvokeEvent,
    rawId: unknown,
  ): WebContents {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(z.number().int().positive(), [rawId])
    const contents = webContents.fromId(id)
    if (!contents || contents.isDestroyed() || contents.session !== getInAppBrowserSession()) {
      throw new IpcValidationError('Browser sharing rejected: unknown interactive browser tab')
    }
    return contents
  }

  ipcMain.handle('browser:share-page-text', async (event, rawId: unknown) => {
    const share = await captureBrowserPageText(interactiveBrowserContents(event, rawId))
    if (!win.isDestroyed()) win.webContents.send('browser:share-text', share)
  })

  ipcMain.handle('browser:share-screenshot', async (event, rawId: unknown) => {
    const share = await captureBrowserScreenshot(interactiveBrowserContents(event, rawId))
    if (!win.isDestroyed()) win.webContents.send('browser:share-image', share)
  })

  ipcMain.handle('workspace:set', async (event, root: unknown, sshHostArg?: unknown) => {
    assertMainFrameSender(event, win)
    const parsedRoot = parseIpcArgs(zPathString, [root])
    const explicitSshHost = parseIpcArgs(z.string().max(128).optional(), [sshHostArg])
    const projects = storedWorkspaceProjects()
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
    // Now a workspace is available, refresh any ACP model caches that have aged
    // past the TTL. Fire-and-forget: the picker reads settings live, so fresh
    // models (e.g. a new Opus release) appear on its next open without blocking
    // boot or requiring a manual "Detect models".
    revalidateStaleAcpModels()
    return canonical
  })

  const threadPathArgs = z.tuple([zProjectId, zThreadId, zPathString])

  ipcMain.handle('fs:readFile', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(threadPathArgs, rawArgs)
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    const abs = await resolvePathWithinRoot(relPath, root)
    return gatewayReadFile(abs, root)
  })

  ipcMain.handle('fs:writeFile', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath, content] = parseIpcArgs(
      z.tuple([zProjectId, zThreadId, zPathString, z.string()]),
      rawArgs,
    )
    assertFsWriteContent(content)
    const context = await resolveThreadExecutionContext(projectId, threadId)
    const abs = await resolvePathWithinRoot(relPath, context.root)
    await gatewayWriteFile(abs, content, context.root)
    scheduleIndexRebuild(context.root)
  })

  ipcMain.handle('fs:readdir', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(threadPathArgs, rawArgs)
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    const abs = await resolvePathWithinRoot(relPath, root)
    return gatewayReaddir(abs, root)
  })

  ipcMain.handle('fs:listDir', async (event, projectIdArg, threadIdArg, pathArg) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(
      z.tuple([zProjectId, zThreadId, zPathString.optional()]),
      [projectIdArg, threadIdArg, pathArg],
    )
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    const abs = await resolvePathWithinRoot(nonEmptyStringOr(relPath, '.'), root)
    const dirents = await gatewayListDir(abs, root)
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
    // Renderer-global feature (command palette / `@` mention picker), scoped
    // to the renderer-selected workspace root, not any one thread's execution root.
    const root = getWorkspaceRoot()
    if (!root) return []
    await whenFileIndexReady(root)
    const idx = getIndex(root)
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
    const root = getWorkspaceRoot()
    if (root) await whenFileIndexReady(root)
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
  const zRoadmapCategory = z.union([z.literal(''), z.enum(ROADMAP_CATEGORIES)])
  const zRoadmapExportFormat = z.enum(ROADMAP_EXPORT_FORMATS)
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
      // Saving is immediate; the complexity and category classification (model
      // round-trips) stamp the note in the background and the pane refreshes on
      // the events.
      void stampRoadmapComplexity(note.id, prompt, notifyRoadmapChanged)
      void stampRoadmapCategory(note.id, prompt, notifyRoadmapChanged)
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
      if (updated && promptChanged) {
        void stampRoadmapComplexity(id, prompt, notifyRoadmapChanged)
        void stampRoadmapCategory(id, prompt, notifyRoadmapChanged)
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

  // Status-only flip (row-level mark-done/reopen, and review triage). Mirrors
  // the roadmap_plan tool's set_status action: no prompt/notes/issue
  // round-trip, so complexity is never re-classified. Re-reading the store
  // avoids overwriting a prompt/notes edit made while a model review ran.
  ipcMain.handle('roadmap:setStatus', (event, rawId: unknown, rawStatus: unknown) => {
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
  ipcMain.handle('roadmap:setCategory', (event, rawId: unknown, rawCategory: unknown) => {
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
  const roadmapIssueSchema = z.object({
    number: z.number().int().positive(),
    title: z.string().max(512),
    body: z.string().max(20_000),
  })
  const roadmapIssuePageSize = 20

  ipcMain.handle('roadmap:openIssues', async (event, rawPage: unknown) => {
    assertMainFrameSender(event, win)
    const page = parseIpcArgs(z.number().int().positive(), [rawPage])
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
    // which surfaces stale/fork origins immediately. Pagination keeps every
    // GitHub/IPC/model operation bounded without imposing a repository-wide
    // issue ceiling on the picker.
    return {
      slug,
      ...(await backend.listWorkspaceOpenIssues(page, roadmapIssuePageSize)),
    }
  })

  const zRoadmapImportIssues = z.array(roadmapIssueSchema).max(roadmapIssuePageSize)

  ipcMain.handle('roadmap:importIssues', (event, rawIssues: unknown) => {
    assertMainFrameSender(event, win)
    const issues = parseIpcArgs(zRoadmapImportIssues, [rawIssues])
    return importIssuesAsRoadmapItems(issues, undefined, undefined, undefined, notifyRoadmapChanged)
  })

  // Semantic coverage for the import picker: which open issues already have a
  // roadmap prompt (even without a pin)? Pin matches stay client-side; this
  // only asks the small-tasks model about the unpinned remainder.
  ipcMain.handle('roadmap:matchOpenIssues', async (event, rawIssues: unknown) => {
    assertMainFrameSender(event, win)
    const issues = parseIpcArgs(zRoadmapImportIssues, [rawIssues])
    return matchOpenIssuesToRoadmapItems(issues)
  })

  // Track the chat thread started from an item ("Start thread" in the pane) in
  // a `thread` frontmatter field, so the pane can offer reopening it later.
  // Restamping is deliberate: starting a fresh thread from the same item points
  // the field at the newest one. An empty threadId clears the tracking.
  ipcMain.handle('roadmap:setThread', (event, rawId: unknown, rawThreadId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zRoadmapId, [rawId])
    const threadId = parseIpcArgs(z.string().max(128).optional(), [rawThreadId])?.trim() ?? ''
    const existing = getKnowledgeNote(id)
    if (!existing || existing.type !== ROADMAP_TYPE) return null
    const { thread: _thread, ...rest } = existing.fields
    return updateKnowledgeNote(id, {
      fields: { ...rest, ...(threadId ? { thread: threadId } : {}) },
    })
  })

  // Advisory fit check of an item's prompt against its pinned issue,
  // explicitly triggered from the pane (see roadmap-fit-check.ts).
  ipcMain.handle('roadmap:checkFit', (event, rawId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zRoadmapId, [rawId])
    return checkRoadmapFit(id)
  })

  ipcMain.handle('roadmap:prepareReview', (event) => {
    assertMainFrameSender(event, win)
    return prepareRoadmapReview()
  })

  ipcMain.handle('roadmap:lastReviewAt', (event) => {
    assertMainFrameSender(event, win)
    return readRoadmapReviewCheckpointForRenderer()
  })

  ipcMain.handle(
    'roadmap:reviewItem',
    async (event, rawId: unknown, rawCommits: unknown, rawRunId: unknown) => {
      assertMainFrameSender(event, win)
      const id = parseIpcArgs(zRoadmapId, [rawId])
      const commits = parseIpcArgs(z.string().max(20_000), [rawCommits])
      const bulkRunId =
        rawRunId === undefined || rawRunId === null ? undefined : parseIpcArgs(z.uuid(), [rawRunId])
      const result = await reviewRoadmapItem(id, commits, 'bulk', bulkRunId)
      notifyRoadmapChanged()
      return result
    },
  )

  ipcMain.handle('roadmap:reviewItemDeep', async (event, rawId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zRoadmapId, [rawId])
    const result = await reviewRoadmapItemDeep(id)
    notifyRoadmapChanged()
    return result
  })

  ipcMain.handle('roadmap:completeReview', (event, rawRunId: unknown) => {
    assertMainFrameSender(event, win)
    const runId = parseIpcArgs(z.uuid(), [rawRunId])
    const completed = completeRoadmapReview(runId)
    notifyRoadmapChanged()
    return completed
  })

  ipcMain.handle('roadmap:abortReview', (event, rawRunId: unknown) => {
    assertMainFrameSender(event, win)
    const runId = parseIpcArgs(z.uuid(), [rawRunId])
    const aborted = abortRoadmapReview(runId)
    notifyRoadmapChanged()
    return aborted
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

  // Deterministic export of the active project's roadmap (RoadmapExporter,
  // shared/roadmap/export.ts) as a downloadable md/html/mhtml/jsonl document —
  // zipped with its attachments under relative paths when any are present.
  ipcMain.handle('roadmap:export', (event, rawFormat: unknown) => {
    assertMainFrameSender(event, win)
    const format = parseIpcArgs(zRoadmapExportFormat, [rawFormat])
    const activeProjectId = getActiveProjectId()
    const project = activeProjectId ? getProjectById(activeProjectId) : null
    if (!project) {
      throw new IpcValidationError('No active project to export a roadmap for.')
    }
    const result = buildRoadmapExport(project, format, new Date().toISOString())
    return {
      filename: result.filename,
      mimeType: result.mimeType,
      dataUrl: `data:${result.mimeType};base64,${Buffer.from(result.data).toString('base64')}`,
      bundled: result.bundled,
      files: result.files,
    }
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
    if (k === READ_TERMINAL_ENABLED_SETTING) {
      syncReadTerminalTools(registry)
    }
    // Keep the native diagnostics menu in sync with Developer mode. The
    // Ctrl+Shift+I shortcut is owned independently by its first-party pack.
    if (k === DEVELOPER_MODE_SETTING) {
      const win = getMainWindow()
      const enabled = typeof value === 'boolean' && value
      if (win) buildAppMenu(win, enabled)
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
    if (p === 'parallel') syncParallelSearchTools(registry)
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
  ipcMain.handle('models:bestValueDefault', () => resolveBestValueChatModel())
  ipcMain.handle('settings:extraProviders', () => getResolvedExtraProviders())
  ipcMain.handle('settings:saveExtraProvider', async (event, record: unknown) => {
    assertMainFrameSender(event, win)
    const parsed = parseIpcArgs(storedExtraProviderSchema.partial({ slug: true }), [record])
    const provider: Parameters<typeof saveExtraProvider>[0] = {}
    if (parsed.slug !== undefined) provider.slug = parsed.slug
    if (parsed.label !== undefined) provider.label = parsed.label
    if (parsed.baseUrl !== undefined) provider.baseUrl = parsed.baseUrl
    if (parsed.keyPrefix !== undefined) provider.keyPrefix = parsed.keyPrefix
    if (parsed.models !== undefined) {
      provider.models = parsed.models.map((model) => {
        const result: NonNullable<Parameters<typeof saveExtraProvider>[0]['models']>[number] = {
          id: model.id,
        }
        if (model.contextWindow !== undefined) result.contextWindow = model.contextWindow
        if (model.inputPricePerMTok !== undefined) {
          result.inputPricePerMTok = model.inputPricePerMTok
        }
        if (model.outputPricePerMTok !== undefined) {
          result.outputPricePerMTok = model.outputPricePerMTok
        }
        return result
      })
    }
    if (parsed.fallbackContextWindow !== undefined) {
      provider.fallbackContextWindow = parsed.fallbackContextWindow
    }
    if (parsed.includeUsage !== undefined) provider.includeUsage = parsed.includeUsage
    if (parsed.extraBody !== undefined) provider.extraBody = parsed.extraBody
    return saveExtraProvider(provider)
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
  ipcMain.handle('usage:getPlanUsage', async () => loadPlanUsageSnapshotAndSample())
  ipcMain.handle('usage:getPlanWorthIt', () => getPlanWorthItPayload())
  ipcMain.handle('usage:setClaudePlanMonthlyFee', async (event, fee: unknown) => {
    assertMainFrameSender(event, win)
    if (fee === null || fee === undefined || fee === '') {
      await setClaudePlanMonthlyFeeUsd(null)
      return getPlanWorthItPayload()
    }
    if (typeof fee !== 'number' || !Number.isFinite(fee)) {
      throw new Error('Claude plan monthly fee must be a positive number or null')
    }
    await setClaudePlanMonthlyFeeUsd(fee)
    return getPlanWorthItPayload()
  })
  // Durable permission-decision audit log (#656). `projectId` is optional — an
  // empty/absent value falls back to the active project.
  ipcMain.handle('decisions:list', (event, rawProjectId: unknown) => {
    assertMainFrameSender(event, win)
    const projectId = parseIpcArgs(zProjectId.optional(), [rawProjectId])
    const resolved = projectId ?? getActiveProjectId()
    if (!resolved) return []
    return readDecisionLog(resolved)
  })
  ipcMain.handle('decisions:export', (event, rawProjectId: unknown) => {
    assertMainFrameSender(event, win)
    const projectId = parseIpcArgs(zProjectId.optional(), [rawProjectId])
    const resolved = projectId ?? getActiveProjectId()
    if (!resolved) throw new Error('No project to export decisions for.')
    return exportDecisionLog(resolved)
  })
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

  const zGuardedYoloThreadId = zNonEmptyString.max(256)
  ipcMain.handle('security:getGuardedYolo', (event, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zGuardedYoloThreadId, [threadId])
    return getGuardedYoloState(id)
  })
  ipcMain.handle('security:enableGuardedYolo', async (event, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zGuardedYoloThreadId, [threadId])
    const current = getGuardedYoloState(id)
    if (current.phase !== 'off') return current
    const containment =
      current.containment === 'project-sandbox'
        ? 'The project sandbox remains in use where possible, but external commands may run unsandboxed.'
        : 'No OS sandbox is active on this platform, so commands run with your full user permissions.'
    const { approved } = await requestApproval({
      title: 'Enable Guarded YOLO for this thread?',
      body: [
        'Routine shell commands, including network and outside-workspace commands, will run without approval in this thread.',
        '',
        containment,
        '',
        'A deterministic host-owned checker will still ask about bounded destructive work and permanently block obvious catastrophic commands. It reduces obvious harm, but it is not a complete security boundary and cannot understand every script or obfuscation.',
        '',
        'Guarded YOLO stays enabled for this thread until you disable it or restart the app.',
      ].join('\n'),
      type: 'shell',
      allowRemember: false,
    })
    if (approved) armGuardedYolo(id)
    return getGuardedYoloState(id)
  })
  ipcMain.handle('security:disableGuardedYolo', (event, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zGuardedYoloThreadId, [threadId])
    disableGuardedYolo(id)
    return getGuardedYoloState(id)
  })
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
    const parsed = parseThreadValue(payload)
    if (parsed === null) throw new IpcValidationError('Invalid thread payload')
    return createThread(id, parsed)
  })
  ipcMain.handle(
    'threads:appendMessage',
    (event, projectId: unknown, threadId: unknown, message: unknown) => {
      assertMainFrameSender(event, win)
      const [pid, tid, payload] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, z.record(z.string(), z.unknown())]),
        [projectId, threadId, message],
      )
      const parsed = parseMessageValue(payload)
      if (parsed === null) throw new IpcValidationError('Invalid message payload')
      return appendMessage(pid, tid, parsed)
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
  // The whole thread directory, zipped — the archive counterpart to the
  // renderer-side JSONL export. Bytes go back over IPC; the renderer names the
  // download and saves it, exactly as it does for the `.jsonl`.
  ipcMain.handle('threads:exportArchive', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, tid] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return buildThreadArchive(pid, tid)
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

  ipcMain.handle('threads:listOrphans', (event) => {
    assertMainFrameSender(event, win)
    const projectIds = recordArrayOrEmpty(storageGet('projects')).flatMap((project) => {
      const id = project['id']
      return typeof id === 'string' && id.length > 0 ? [id] : []
    })
    return listOrphanProjectStores(projectIds)
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
  ipcMain.handle('packs:list', async (event) => {
    assertMainFrameSender(event, win)
    await getPackService().refreshPackSources()
    return { packs: getPackService().list() }
  })
  ipcMain.handle('packs:addSource', async (event) => {
    assertMainFrameSender(event, win)
    const result = await dialog.showOpenDialog(win, {
      title: 'Add pack',
      properties: ['openDirectory'],
    })
    const sourcePath = result.filePaths[0]
    if (!result.canceled && sourcePath) {
      await getPackService().addPackSource(sourcePath)
    }
    return { packs: getPackService().list() }
  })
  ipcMain.handle('packs:setEnabled', async (event, rawId: unknown, rawEnabled: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zNonEmptyString.max(128), [rawId])
    const enabled = parseIpcArgs(z.boolean(), [rawEnabled])
    await getPackService().setEnabled(id, enabled)
    // P5: toggling the model-comparison pack adds/removes its `compare_models`
    // tool on the live registry so the atomic pack-disable also drops the tool
    // from the model tool list without an app restart (mirrors the setting
    // toggles above for the other syncable tools).
    if (id === MODEL_COMPARISON_PACK_ID) {
      syncModelComparisonTools(registry)
    }
    // Same for the `copse.long-horizon-tasks` pack's `track_long_task` tool.
    if (id === LONG_HORIZON_TASKS_PACK_ID) {
      syncLongHorizonTasksTools(registry)
    }
    // Same for the `copse.roadmap-plans` pack's `roadmap_plan` tool.
    if (id === ROADMAP_PLANS_PACK_ID) {
      syncRoadmapPlanTools(registry)
    }
    // Same for the `copse.advisor-strategy` pack's `advisor` tool.
    if (id === ADVISOR_STRATEGY_PACK_ID) {
      syncAdvisorStrategyTools(registry)
    }
    // Same for the `copse.okf-memories` pack's `remember`/`recall` tools — the
    // atomic pack-disable also drops the tools from the model tool list (and
    // stops the memory prompt block) without an app restart.
    if (id === OKF_MEMORIES_PACK_ID) {
      syncOkfMemoryTools(registry)
    }
    // Same for the `copse.ci-investigator` pack's entry and gh_run_* helper
    // tools; the register direction still requires `gh` availability.
    if (id === CI_INVESTIGATOR_PACK_ID) {
      syncCiInvestigatorTools(registry)
    }
    // Same for the `copse.pii-redaction` pack's `reveal_pii` tool — toggling the
    // pack also arms/disarms the input rewrite and steering block, which read
    // the same pack enablement (see `pii-redactor.ts`, `agent-system-prompt.ts`).
    if (id === PII_REDACTION_PACK_ID) {
      syncPiiTools(registry)
    }
    // The `copse.devtools-shortcut` pack contributes no tool — it owns the
    // `devtools-shortcut` capability. Toggling the pack registers/unregisters the
    // global Ctrl+Shift+I shortcut so the atomic pack-disable turns it off
    // without an app restart (mirrors the tool syncs above).
    if (id === DEVTOOLS_SHORTCUT_PACK_ID) {
      syncDevtoolsShortcut(win)
    }
    // Same for the `copse.background-tasks` pack's `run_background` tool — the
    // atomic pack-disable also revokes the pack's declared `loopback-bind`
    // sandbox relaxation (the permission-gate reads `isPermissionDeclared`).
    if (id === BACKGROUND_TASKS_PACK_ID) {
      syncBackgroundTasksTools(registry)
    }
    if (id === PARALLEL_SEARCH_PACK_ID) {
      syncParallelSearchTools(registry)
    }
    if (id === DARK_FACTORY_PACK_ID) {
      syncDarkFactorySensor()
    }
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

  // Local cron automation prototype (`copse.automations`). Every operation is
  // project-scoped; the service repeats that ownership check for update/delete
  // so a renderer cannot address a schedule through another project id.
  ipcMain.handle('automations:list', (event, rawProjectId: unknown) => {
    assertMainFrameSender(event, win)
    const projectId = parseIpcArgs(zProjectId, [rawProjectId])
    return getAutomationService().list(projectId)
  })
  ipcMain.handle('automations:upsert', async (event, rawProjectId: unknown, rawInput: unknown) => {
    assertMainFrameSender(event, win)
    const projectId = parseIpcArgs(zProjectId, [rawProjectId])
    const input = parseIpcArgs(zAutomationScheduleInput, [rawInput])
    return getAutomationService().upsert(projectId, {
      ...(input.id !== undefined ? { id: input.id } : {}),
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      model: input.model,
      enabled: input.enabled,
    })
  })
  ipcMain.handle(
    'automations:remove',
    async (event, rawProjectId: unknown, rawScheduleId: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, scheduleId] = parseIpcArgs(
        z.tuple([zProjectId, zNonEmptyString.max(256)]),
        [rawProjectId, rawScheduleId],
      )
      await getAutomationService().remove(projectId, scheduleId)
    },
  )
  ipcMain.handle(
    'automations:runNow',
    async (event, rawProjectId: unknown, rawScheduleId: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, scheduleId] = parseIpcArgs(
        z.tuple([zProjectId, zNonEmptyString.max(256)]),
        [rawProjectId, rawScheduleId],
      )
      return getAutomationService().runNow(projectId, scheduleId)
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
  ipcMain.handle('cursorRules:list', async () => {
    const root = getWorkspaceRoot()
    if (!root) return []
    return toCursorRuleSummaries(await discoverCursorRules(root))
  })

  const threadOwnerArgs = z.tuple([zProjectId, zThreadId])

  ipcMain.handle('git:isAvailable', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    return (await isGitAvailableForTarget()) && (await isInsideGitWorkTree(root))
  })
  ipcMain.handle('git:status', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    return getGitStatus((await resolveThreadExecutionContext(projectId, threadId)).root)
  })
  ipcMain.handle('git:changeStats', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    return getGitChangeStats((await resolveThreadExecutionContext(projectId, threadId)).root)
  })
  ipcMain.handle('git:fileDiff', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, filePath, isStaged] = parseIpcArgs(
      z.tuple([zProjectId, zThreadId, zPathString, z.boolean()]),
      rawArgs,
    )
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    return getGitFileDiff(filePath, isStaged, root)
  })
  ipcMain.handle('git:workingFileDiff', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, filePath] = parseIpcArgs(threadPathArgs, rawArgs)
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    return getGitWorkingFileDiff(filePath, root)
  })
  ipcMain.handle('git:branchStatus', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    // Git-ref charset only, no leading dash: the branch reaches `gh pr list
    // --head <branch>` and must never be option-shaped (#580).
    const [projectId, threadId, branch] = parseIpcArgs(
      z.tuple([
        zProjectId,
        zThreadId,
        z
          .string()
          .max(256)
          .regex(/^[A-Za-z0-9_][A-Za-z0-9_\-./]*$/)
          .optional(),
      ]),
      rawArgs,
    )
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    return getGitBranchStatus(branch, root)
  })
  ipcMain.handle('git:checkoutBranch', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, targetBranch] = parseIpcArgs(
      z.tuple([zProjectId, zThreadId, z.string().min(1).max(256)]),
      rawArgs,
    )
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    await checkoutGitBranch(targetBranch, root)
  })
  ipcMain.handle('git:listBranches', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    return getBranches((await resolveThreadExecutionContext(projectId, threadId)).root)
  })
  ipcMain.handle('git:getDefaultBranch', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    return getDefaultBranch((await resolveThreadExecutionContext(projectId, threadId)).root)
  })
  ipcMain.handle('git:sessionBackup', (event, projectIdArg: unknown, threadIdArg: unknown) => {
    assertMainFrameSender(event, win)
    const projectId = parseIpcArgs(zProjectId, [projectIdArg])
    const threadId = parseIpcArgs(zThreadId, [threadIdArg])
    return getSessionBackup({ projectId, threadId })
  })
  ipcMain.handle(
    'git:restoreBackup',
    async (event, projectIdArg: unknown, threadIdArg: unknown) => {
      assertMainFrameSender(event, win)
      const projectId = parseIpcArgs(zProjectId, [projectIdArg])
      const threadId = parseIpcArgs(zThreadId, [threadIdArg])
      return restoreSessionBackup({ projectId, threadId })
    },
  )

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
  /**
   * Import Cursor cloud agents launched outside Copse as local thread stubs.
   * Prefer passing the renderer’s active `projectId` so sync stays scoped to the
   * open project. Caller should reload/merge project threads after imports.
   */
  ipcMain.handle('remoteAgent:discoverExternal', (event, projectId: unknown) => {
    assertMainFrameSender(event, win)
    if (projectId === undefined || projectId === null) {
      return discoverExternalCursorAgents()
    }
    const id = parseIpcArgs(zProjectId, [projectId])
    return discoverExternalCursorAgents({ projectId: id })
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
  ipcMain.handle('editors:open', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, parsedId] = parseIpcArgs(
      z.tuple([zProjectId, zThreadId, z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)]),
      rawArgs,
    )
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    return openWorkspaceInExternalEditor(parsedId, root)
  })

  ipcMain.handle('panes:popout', (event, mode: unknown, seed: unknown) => {
    assertMainFrameSender(event, win)
    const parsed = parseIpcArgs(
      z.enum(['explorer', 'terminal', 'changes', 'prs', 'memories', 'roadmap', 'browser']),
      [mode],
    )
    createPanePopoutWindow(parsed, seed)
  })

  ipcMain.handle('panes:takePopoutSeed', (event, mode: unknown) => {
    assertMainFrameSender(event, win)
    const parsed = parseIpcArgs(
      z.enum(['explorer', 'terminal', 'changes', 'prs', 'memories', 'roadmap', 'browser']),
      [mode],
    )
    return takePopoutSeed(parsed)
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
    const testAgentChunkSchema = z.discriminatedUnion('type', [
      z.object({
        type: z.literal('tool_call'),
        toolCall: z.object({
          id: z.string().min(1).max(256),
          name: z.string().min(1).max(2_000),
          args: z.unknown(),
          kind: z.string().max(128).optional(),
        }),
      }),
      z.object({
        type: z.literal('tool_call_update'),
        toolCallId: z.string().min(1).max(256),
        name: z.string().max(2_000).optional(),
        args: z.unknown().optional(),
        status: z.enum(['running', 'done', 'error']).optional(),
        result: z.string().max(200_000).optional(),
        resultFormat: z.literal('markdown').optional(),
      }),
    ])
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
      const script: MockScriptStep[] = steps.map((step) => ({
        when: step.when,
        ...(step.tool ? { tool: step.tool } : {}),
        ...(step.text === undefined ? {} : { text: step.text }),
      }))
      setMockScript(script)
      return { steps: steps.length, cursor: mockScriptCursorForTests() }
    })
    ipcMain.handle('test:clearMockScript', (event) => {
      assertMainFrameSender(event, win)
      clearMockScript()
    })
    ipcMain.handle('test:emitAgentChunks', (event, rawThreadId: unknown, rawChunks: unknown) => {
      assertMainFrameSender(event, win)
      const [threadId, chunks] = parseIpcArgs(
        z.tuple([z.string().min(1).max(256), z.array(testAgentChunkSchema).max(16)]),
        [rawThreadId, rawChunks],
      )
      for (const chunk of chunks) win.webContents.send('agent:chunk', threadId, chunk)
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
      return requestAcpPackageInstallApproval([{ agent: codex, action: 'install' }])
    })
    ipcMain.handle('test:requestAcpPackageUpgradeApproval', (event) => {
      assertMainFrameSender(event, win)
      const codex = KNOWN_ACP_AGENTS.find((agent) => agent.id === 'codex')
      if (!codex) throw new IpcValidationError('Codex ACP preset is missing')
      return requestAcpPackageInstallApproval([
        {
          agent: codex,
          action: 'upgrade',
          fromVersion: '1.1.0',
          toVersion: '1.1.7',
        },
      ])
    })
    ipcMain.handle('test:setSemanticIndexScaleGuard', (event, phase: unknown, reason: unknown) => {
      assertMainFrameSender(event, win)
      const [parsedPhase, parsedReason] = parseIpcArgs(
        z.tuple([z.enum(['limited', 'skipped']), z.string().min(1).max(500)]),
        [phase, reason],
      )
      setSemanticIndexScaleGuarded(parsedPhase, parsedReason)
    })
  }
}
