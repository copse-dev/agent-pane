import { dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import micromatch from 'micromatch'
import { createPanePopoutWindow } from '../windows/create-popout-window.ts'
import {
  assertAllowedWorkspaceRoot,
  getWorkspaceRoot,
  registerAllowedWorkspaceRoot,
  resolveWorkspacePath,
  seedAllowedWorkspaceRoots,
  setWorkspaceRoot,
} from '../services/workspace.ts'
import {
  assertFsWriteContent,
  isIndexQueryPattern,
  assertMainFrameSender,
  assertStorageKey,
  IpcValidationError,
  keyProviderSchema,
  parseIpcArgs,
  zMcpServerName,
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
import { getSetting, setSetting, hasApiKey, setApiKey } from '../services/storage/settings.ts'
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
import { fetchOpenAiCompatibleModels } from '../services/providers/provider-models.ts'
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
import { listAcpModelsForAgent } from '../services/acp/acp-agent-service.ts'
import { runAcpAutoSetup } from '../services/acp/acp-auto-setup.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'
import { listSkills, initSkillsRegistry } from '../services/skills/skills-registry.ts'
import { listCursorPlugins } from '../services/skills/cursor-plugins.ts'
import { listCursorHooks } from '../services/skills/cursor-hooks.ts'
import { loadProjectInstructionSources } from '../services/project-instructions.ts'
import {
  registerSkillTools,
  syncOkfMemoryTools,
  syncPiiTools,
} from '../services/registry-bootstrap.ts'
import { PII_REDACTION_ENABLED_SETTING } from '../services/security/pii-redactor.ts'
import {
  OKF_MEMORIES_ENABLED_SETTING,
  MEMORY_TYPE,
  migrateLegacyMemories,
} from '../tools/memory-tools.ts'
import {
  addKnowledgeNote,
  deleteKnowledgeNote,
  loadKnowledgeNotes,
  updateKnowledgeNote,
} from '../services/storage/knowledge-store.ts'
import {
  checkoutGitBranch,
  getBranches,
  getDefaultBranch,
  getGitChangeStats,
  getGitFileDiff,
  getGitStatus,
  isInsideGitWorkTree,
} from '../services/github/git-service.ts'
import { getGitBranchStatus } from '../services/github/pr-context-service.ts'
import { isGitAvailable } from '../services/tool-availability.ts'
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
import {
  fetchRemoteArtifactImageDataUrl,
  resolveRemoteArtifactDownloadUrl,
} from '../services/remote/remote-agent-client.ts'
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
  const storedProjects = (storageGet('projects') as { path: string }[] | null) ?? []
  seedAllowedWorkspaceRoots(storedProjects.map((p) => p.path))
  const persistedRoot = getWorkspaceRoot()
  if (persistedRoot) {
    try {
      registerAllowedWorkspaceRoot(persistedRoot)
    } catch {
      // Stale workspaceRoot in config — ignore until user picks a folder.
    }
  }

  ipcMain.handle('workspace:open', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    const root = registerAllowedWorkspaceRoot(result.filePaths[0])
    setWorkspaceRoot(root)
    // Scheduled, not awaited — index builds must not block the renderer's
    // swap to the full layout; the footer indicator reports progress.
    startWorkspaceIndexing(root)
    await initSkillsRegistry()
    registerSkillTools(registry)
    return root
  })

  ipcMain.handle('workspace:get', () => getWorkspaceRoot())

  ipcMain.handle('workspace:set', async (_e, root: string) => {
    const projects = (storageGet('projects') as { path: string }[] | null) ?? []
    seedAllowedWorkspaceRoots(projects.map((p) => p.path))
    const canonical = assertAllowedWorkspaceRoot(root)
    setWorkspaceRoot(canonical)
    startWorkspaceIndexing(canonical)
    await initSkillsRegistry()
    registerSkillTools(registry)
    return canonical
  })

  ipcMain.handle('fs:readFile', async (event, path: unknown) => {
    assertMainFrameSender(event, win)
    const relPath = parseIpcArgs(zPathString, [path])
    const abs = resolveWorkspacePath(relPath)
    return gatewayReadFile(abs)
  })

  ipcMain.handle('fs:writeFile', async (event, path: unknown, content: unknown) => {
    assertMainFrameSender(event, win)
    const relPath = parseIpcArgs(zPathString, [path])
    if (typeof content !== 'string') throw new IpcValidationError('File content must be a string')
    assertFsWriteContent(content)
    const abs = resolveWorkspacePath(relPath)
    await gatewayWriteFile(abs, content)
    scheduleIndexRebuild()
  })

  ipcMain.handle('fs:readdir', async (event, path: unknown) => {
    assertMainFrameSender(event, win)
    const relPath = parseIpcArgs(zPathString, [path])
    const abs = resolveWorkspacePath(relPath)
    return gatewayReaddir(abs)
  })

  ipcMain.handle('fs:listDir', async (event, path: unknown) => {
    assertMainFrameSender(event, win)
    const relPath = parseIpcArgs(zPathString.optional(), [path])
    const abs = resolveWorkspacePath(relPath || '.')
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
    return resolveFileReferences(candidates)
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
    // Same for the experimental PII redaction reveal tool.
    if (k === PII_REDACTION_ENABLED_SETTING) {
      syncPiiTools(registry)
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
    await Promise.all(Object.entries(prefs).map(([k, v]) => setSetting(k, v)))
  })
  ipcMain.handle('settings:getKey', (_e, provider: unknown) => {
    const p = parseIpcArgs(keyProviderSchema, [provider])
    return hasApiKey(p)
  })
  ipcMain.handle('settings:setKey', (event, provider: unknown, key: unknown) => {
    assertMainFrameSender(event, win)
    const p = parseIpcArgs(keyProviderSchema, [provider])
    const apiKey = parseIpcArgs(z.string().max(8192), [key])
    setApiKey(p, apiKey)
    invalidateProviderKeyStatus(p)
    // Saving an HF token auto-populates its priced, provider-pinned model list so
    // the picker and cost estimate work without a manual fetch (fire-and-forget).
    if (p === HUGGINGFACE_SLUG && apiKey.trim()) {
      void refreshHuggingFaceModels(apiKey).catch(() => {})
    }
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
      setApiKey(d.provider, d.value)
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
    return fetchOpenAiCompatibleModels(url, apiKey)
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
  ipcMain.handle('hooks:list', () => {
    const root = getWorkspaceRoot()
    return listCursorHooks({ workspaceRoot: root, projectTrusted: isWorkspaceTrusted(root) })
  })
  ipcMain.handle('instructions:list', async () =>
    (await loadProjectInstructionSources()).map(({ path, name, scope, content }) => ({
      path,
      name,
      scope,
      bytes: Buffer.byteLength(content, 'utf-8'),
    })),
  )

  ipcMain.handle('git:isAvailable', async () => isGitAvailable() && (await isInsideGitWorkTree()))
  ipcMain.handle('git:status', () => getGitStatus())
  ipcMain.handle('git:changeStats', () => getGitChangeStats())
  ipcMain.handle('git:fileDiff', (event, path: unknown, staged: unknown) => {
    assertMainFrameSender(event, win)
    const filePath = parseIpcArgs(zPathString, [path])
    const isStaged = parseIpcArgs(z.boolean(), [staged])
    return getGitFileDiff(filePath, isStaged)
  })
  ipcMain.handle('git:branchStatus', (_e, forBranch: unknown) => {
    const branch =
      forBranch === undefined ? undefined : parseIpcArgs(z.string().max(256), [forBranch])
    return getGitBranchStatus(branch)
  })
  ipcMain.handle('git:checkoutBranch', async (event, branch: unknown) => {
    assertMainFrameSender(event, win)
    const targetBranch = parseIpcArgs(z.string().min(1).max(256), [branch])
    await checkoutGitBranch(targetBranch)
  })
  ipcMain.handle('git:listBranches', () => getBranches())
  ipcMain.handle('git:getDefaultBranch', () => getDefaultBranch())

  ipcMain.handle('gh:status', () => getGhCliStatus())
  ipcMain.handle('gh:listMyOpenPrs', () => listMyOpenPrs())
  ipcMain.handle('gh:listWorkspaceOpenPrs', () => listWorkspaceOpenPrs())
  ipcMain.handle('gh:prChecks', (_e, owner: unknown, repo: unknown, number: unknown) => {
    const parsedOwner = parseIpcArgs(z.string().min(1).max(128), [owner])
    const parsedRepo = parseIpcArgs(z.string().min(1).max(128), [repo])
    const parsedNumber = parseIpcArgs(z.number().int().positive(), [number])
    return getGhPrChecksState({ owner: parsedOwner, repo: parsedRepo, number: parsedNumber })
  })
  ipcMain.handle('gh:prDetails', (_e, owner: unknown, repo: unknown, number: unknown) => {
    const parsedOwner = parseIpcArgs(z.string().min(1).max(128), [owner])
    const parsedRepo = parseIpcArgs(z.string().min(1).max(128), [repo])
    const parsedNumber = parseIpcArgs(z.number().int().positive(), [number])
    return getGhPrDetails({ owner: parsedOwner, repo: parsedRepo, number: parsedNumber })
  })
  ipcMain.handle(
    'gh:prFileDiff',
    (_e, owner: unknown, repo: unknown, number: unknown, path: unknown) => {
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
  ipcMain.handle('gh:resolvePrUrl', (_e, url: unknown) => {
    const parsedUrl = parseIpcArgs(z.url().max(2048), [url])
    return resolveGithubPrRef(parsedUrl)
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
  ipcMain.handle('acp:detectAgents', (event) => {
    assertMainFrameSender(event, win)
    return detectAcpAgents()
  })
  ipcMain.handle('acp:listModels', (event, agentId: unknown) => {
    assertMainFrameSender(event, win)
    if (typeof agentId !== 'string') throw new Error('acp:listModels requires an agent id')
    return listAcpModelsForAgent(agentId)
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

  ipcMain.handle('panes:popout', (event, mode: unknown) => {
    assertMainFrameSender(event, win)
    const parsed = parseIpcArgs(
      z.enum(['explorer', 'terminal', 'changes', 'prs', 'memories', 'browser']),
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
  }
}
