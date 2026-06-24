import { dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import micromatch from 'micromatch'
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
  parseIpcArgs,
  providerSchema,
  zNonEmptyString,
  zPathString,
} from './ipc-guards.ts'
import { buildIndex, getIndex } from '../services/file-index.ts'
import { resolveFileReferences } from '../services/file-reference-resolver.ts'
import { ensureSemanticIndex } from '../services/semantic-index.ts'
import {
  scheduleIndexRebuild,
  startWorkspaceIndexWatcher,
} from '../services/workspace-index-watcher.ts'
import {
  getSetting,
  setSetting,
  hasApiKey,
  setApiKey,
  isProviderAvailable,
} from '../services/settings.ts'
import {
  isRendererWritableSettingKey,
  parseRendererWritableSetting,
  securitySettingsSchema,
} from '../services/settings-writable.ts'
import { storageGet, storageSet } from '../services/storage.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'
import { listSkills, initSkillsRegistry } from '../services/skills-registry.ts'
import { listCursorPlugins } from '../services/cursor-plugins.ts'
import { listCursorHooks } from '../services/cursor-hooks.ts'
import { registerSkillTools } from '../services/registry-bootstrap.ts'
import {
  checkoutGitBranch,
  getGitFileDiff,
  getGitStatus,
  isInsideGitWorkTree,
} from '../services/git-service.ts'
import { getGitBranchStatus } from '../services/pr-context-service.ts'
import { isGitAvailable } from '../services/tool-availability.ts'
import {
  getMcpServerStatuses,
  reloadMcpServers,
  setMcpServerUserEnabled,
  setWorkspaceTrustAndReload,
} from '../services/mcp-registry.ts'
import { isWorkspaceTrusted } from '../services/workspace-trust.ts'
import {
  setMockScript,
  clearMockScript,
  mockScriptCursorForTests,
  type MockScriptStep,
} from '@shared/llm/mock-script.ts'
import { applyAppIcon } from '../app-icon.ts'
import { getMainWindow } from '../windows/create-main-window.ts'
import { validateApiKey } from '../services/validate-api-key.ts'
import {
  fetchRemoteArtifactImageDataUrl,
  resolveRemoteArtifactDownloadUrl,
} from '../services/remote-agent-client.ts'
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
    await buildIndex(root)
    void ensureSemanticIndex(root)
    startWorkspaceIndexWatcher(root)
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
    await buildIndex(canonical)
    void ensureSemanticIndex(canonical)
    startWorkspaceIndexWatcher(canonical)
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

  ipcMain.handle('index:query', (event, pattern: unknown) => {
    assertMainFrameSender(event, win)
    if (pattern !== undefined && typeof pattern !== 'string') {
      throw new IpcValidationError('Index query pattern must be a string')
    }
    const query = typeof pattern === 'string' ? pattern : ''
    if (query && !isIndexQueryPattern(query)) return []
    const idx = getIndex()
    if (!idx) return []
    return query ? micromatch(idx.paths, `**/*${query}*`).slice(0, 20) : idx.paths.slice(0, 20)
  })

  ipcMain.handle('index:resolveFileReferences', (event, rawCandidates: unknown) => {
    assertMainFrameSender(event, win)
    const candidates = parseIpcArgs(z.array(z.string().min(1).max(4096)).max(200), [rawCandidates])
    return resolveFileReferences(candidates)
  })

  ipcMain.handle('settings:get', (_e, key: unknown) => {
    const k = parseIpcArgs(zNonEmptyString.max(128), [key])
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
  })
  ipcMain.handle('settings:setSecurity', async (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    const prefs = securitySettingsSchema.parse(raw)
    await Promise.all(Object.entries(prefs).map(([k, v]) => setSetting(k, v)))
  })
  ipcMain.handle('settings:getKey', (_e, provider: unknown) => {
    const p = parseIpcArgs(providerSchema, [provider])
    return hasApiKey(p)
  })
  ipcMain.handle('settings:setKey', (event, provider: unknown, key: unknown) => {
    assertMainFrameSender(event, win)
    const p = parseIpcArgs(providerSchema, [provider])
    const apiKey = parseIpcArgs(z.string().max(8192), [key])
    setApiKey(p, apiKey)
  })
  ipcMain.handle('settings:availableProviders', () => ({
    anthropic: isProviderAvailable('anthropic'),
    openai: isProviderAvailable('openai'),
    cursor: isProviderAvailable('cursor'),
    openrouter: isProviderAvailable('openrouter'),
  }))
  ipcMain.handle('settings:validateKey', async (event, provider: unknown, key: unknown) => {
    assertMainFrameSender(event, win)
    const p = parseIpcArgs(z.enum(['anthropic', 'openai', 'cursor', 'openrouter']), [provider])
    const apiKey = parseIpcArgs(z.string().max(8192), [key])
    return validateApiKey(p, apiKey)
  })
  ipcMain.handle('app-icon:apply', () => {
    const mainWin = getMainWindow()
    applyAppIcon(mainWin && !mainWin.isDestroyed() ? [mainWin] : [])
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

  ipcMain.handle('skills:list', () => listSkills())
  ipcMain.handle('plugins:list', () => listCursorPlugins())
  ipcMain.handle('hooks:list', () => {
    const root = getWorkspaceRoot()
    return listCursorHooks({ workspaceRoot: root, projectTrusted: isWorkspaceTrusted(root) })
  })

  ipcMain.handle('git:isAvailable', async () => isGitAvailable() && (await isInsideGitWorkTree()))
  ipcMain.handle('git:status', () => getGitStatus())
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
  ipcMain.handle('shell:openExternal', (event, url: unknown) => {
    assertMainFrameSender(event, win)
    const href = parseIpcArgs(z.string().url().max(2048), [url])
    if (!href.startsWith('http://') && !href.startsWith('https://')) {
      throw new IpcValidationError('URL must be http or https')
    }
    return shell.openExternal(href)
  })

  ipcMain.handle('mcp:list', () => getMcpServerStatuses())
  ipcMain.handle('mcp:reload', async () => {
    const statuses = await reloadMcpServers(registry)
    win.webContents.send('mcp:status_changed', statuses)
    return statuses
  })
  ipcMain.handle('mcp:setEnabled', async (_e, name: string, enabled: boolean) => {
    await setMcpServerUserEnabled(name, enabled)
    const statuses = await reloadMcpServers(registry)
    win.webContents.send('mcp:status_changed', statuses)
    return statuses
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
  if (process.env.COPSE_E2E === '1') {
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
