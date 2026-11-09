import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { revalidateStaleAcpModels, runAcpAutoSetup } from '../services/acp/acp-auto-setup.ts'
import { initAgentsRegistry } from '../services/agents/agents-registry.ts'
import { perfSpan, perfSyncSpan } from '../services/diagnostics/perf-trace.ts'
import { setWorkspaceTrustAndReload } from '../services/mcp/mcp-registry.ts'
import { scaffoldProject } from '../services/project-scaffold.ts'
import { registerSkillTools } from '../services/registry-bootstrap.ts'
import { startWorkspaceIndexing } from '../services/search/workspace-indexing.ts'
import { isWorkspaceTrusted } from '../services/security/workspace-trust.ts'
import { initSkillsRegistry } from '../services/skills/skills-registry.ts'
import { getSshConnectionManager } from '../services/ssh-workspace/connection-manager.ts'
import { getSetting } from '../services/storage/settings.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'
import { WorkspaceActivation } from '../services/workspace-activation.ts'
import { prepareWorkspaceConnection } from '../services/workspace-connection.ts'
import {
  assertAllowedWorkspaceRoot,
  getWorkspaceRoot,
  registerAllowedWorkspaceRoot,
  resolveSshHostForWorkspaceRoot,
  seedAllowedWorkspaceRoots,
  setWorkspaceRoot,
  workspaceProjectsToSeed,
  type WorkspaceProjectRef,
} from '../services/workspace.ts'
import { storageGet } from '../services/storage/storage.ts'
import { recordArrayOrEmpty } from '@shared/unknown-value.ts'
import { confirmNativeAction } from '../services/native-human-confirmation.ts'
import { broadcastToAppWindows } from '../windows/app-window-broadcast.ts'
import {
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  zPathString,
} from './ipc-guards.ts'

export function storedWorkspaceProjects(): WorkspaceProjectRef[] {
  return recordArrayOrEmpty(storageGet('projects')).flatMap((project) => {
    const path = project['path']
    const sshHost = project['sshHost']
    if (typeof path !== 'string') return []
    return [typeof sshHost === 'string' ? { path, sshHost } : { path }]
  })
}

export function registerWorkspaceHandlers(
  win: BrowserWindow,
  registry: ToolRegistry,
  reloadMcpForWorkspace: () => void,
): void {
  ipcMain.handle('workspace:open', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    const root = await registerAllowedWorkspaceRoot(result.filePaths[0])
    setWorkspaceRoot(root)
    reloadMcpForWorkspace()
    // Scheduled, not awaited — index builds must not block the renderer's
    // swap to the full layout; the footer indicator reports progress.
    startWorkspaceIndexing(root, { kind: 'local' })
    await initSkillsRegistry()
    await initAgentsRegistry()
    registerSkillTools(registry)
    return root
  })

  // Create a brand-new project folder under a user-chosen parent directory:
  // mkdir the folder, write starter AGENT.md + README.md, `git init` it, and
  // register it through the same allowed-root trust boundary as Open Folder.
  // Returns the canonical new path, or null if the parent was cancelled.
  // The user's home directory, used to default the New project dialog's parent
  // when no prior local project gives a better guess. Treated as a data value
  // (not a workspace root), so it is never registered as allowed.
  ipcMain.handle('workspace:get-home-directory', (event) => {
    assertMainFrameSender(event, win)
    return homedir()
  })

  // Parent-directory picker for the "New project" dialog's Browse button. This
  // is a bare pick — it does NOT register the chosen folder as a workspace root
  // (the project folder created under it is registered by `workspace:create-project`).
  ipcMain.handle('workspace:pick-parent-directory', async (event) => {
    assertMainFrameSender(event, win)
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a parent directory for the new project',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  // Create a brand-new project folder under a caller-chosen parent directory:
  // mkdir the folder, write starter AGENT.md + README.md, `git init` it, and
  // register it through the same allowed-root trust boundary as Open Folder.
  ipcMain.handle(
    'workspace:create-project',
    async (event, rawName: unknown, rawParent: unknown) => {
      assertMainFrameSender(event, win)
      const name = parseIpcArgs(z.string().trim().min(1).max(200), [rawName])
      const parentDir = parseIpcArgs(zPathString, [rawParent])
      const requestedPath = join(parentDir, name)
      // Never escape the chosen parent (a crafted name like `..` must not climb).
      if (resolve(parentDir, name) !== requestedPath || basename(requestedPath) !== name) {
        throw new IpcValidationError('Invalid project name')
      }
      const projectPath = join(await realpath(parentDir), name)
      if (!(await confirmNativeAction(event.sender, {
        title: 'Create project folder?',
        detail: `Create and open ${JSON.stringify(projectPath)}? Copse will write starter files there and grant this project access to that folder.`,
        approveLabel: 'Create project',
      }))) throw new IpcValidationError('Project creation was not confirmed')
      let projectMissing = false
      try {
        const existing = await stat(projectPath)
        if (!existing.isDirectory())
          throw new IpcValidationError('Target exists and is not a folder')
        const entries = await readdir(projectPath)
        if (entries.length > 0)
          throw new IpcValidationError('Folder already exists and is not empty')
      } catch (err) {
        // ENOENT means the folder does not exist yet — scaffolding proceeds below.
        if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        projectMissing = true
      }
      if (projectMissing) await mkdir(projectPath, { recursive: true })
      await scaffoldProject(projectPath, name, projectMissing)
      const root = await registerAllowedWorkspaceRoot(projectPath)
      return root
    },
  )

  ipcMain.handle('workspace:get', () => getWorkspaceRoot())

  const workspaceActivations = new WeakMap<WebContents, WorkspaceActivation>()
  ipcMain.handle('workspace:set', async (event, root: unknown, sshHostArg?: unknown) => {
    assertMainFrameSender(event, win)
    const parsedRoot = parseIpcArgs(zPathString, [root])
    const explicitSshHost = parseIpcArgs(z.string().max(128).optional(), [sshHostArg])
    let activation = workspaceActivations.get(event.sender)
    if (!activation) {
      activation = new WorkspaceActivation()
      workspaceActivations.set(event.sender, activation)
    }
    const assertCurrentSelection = activation.begin()
    // Each phase is timed separately (COPSE_PERF=1) so a slow switch names the
    // phase, and `loop:stall` records show which of them held the event loop.
    const projects = perfSyncSpan('workspace-set:read-projects', storedWorkspaceProjects)
    const sshHost = perfSyncSpan('workspace-set:resolve-ssh', () =>
      resolveSshHostForWorkspaceRoot(parsedRoot, explicitSshHost),
    )
    await perfSpan(
      'workspace-set:seed',
      () => seedAllowedWorkspaceRoots(workspaceProjectsToSeed(projects, parsedRoot, sshHost)),
      { projects: projects.length },
    )
    assertCurrentSelection()
    const canonical = await perfSpan('workspace-set:assert', () =>
      assertAllowedWorkspaceRoot(parsedRoot, sshHost),
    )
    assertCurrentSelection()
    if (sshHost) {
      const connections = getSshConnectionManager()
      await prepareWorkspaceConnection({
        enabled: getSetting('sshWorkspaceEnabled', false),
        connected: connections.getConnection(sshHost) !== null,
        connect: () => connections.connect(sshHost),
      })
    }
    assertCurrentSelection()
    perfSyncSpan('workspace-set:set-root', () => {
      setWorkspaceRoot(canonical)
    })
    perfSyncSpan('workspace-set:mcp-reload', reloadMcpForWorkspace)
    perfSyncSpan('workspace-set:start-indexing', () => {
      startWorkspaceIndexing(
        canonical,
        sshHost ? { kind: 'ssh', hostId: sshHost, remoteRoot: canonical } : { kind: 'local' },
      )
    })
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
    void initAgentsRegistry().catch((err: unknown) => {
      console.warn('[agents] background init failed:', err)
    })
    // Now a workspace is available, refresh any ACP model caches that have aged
    // past the TTL. Fire-and-forget: the picker reads settings live, so fresh
    // models (e.g. a new Opus release) appear on its next open without blocking
    // boot or requiring a manual "Detect models".
    revalidateStaleAcpModels()
    // Register any already-installed ACP presets so a detected agent (e.g.
    // `claude`, `codex` on PATH) lands in the model picker without the user
    // having to open Settings → ACP agents first. Fire-and-forget for the same
    // reason as above; registering a preset with no package to install never
    // shows an approval dialog, so this stays silent in the common case. Skipped
    // under the e2e harness: specs seed `registeredAcpAgents` explicitly, and
    // this would otherwise pick up whatever ACP CLIs happen to be on the
    // developer's own PATH.
    if (process.env['COPSE_E2E'] !== '1') {
      void runAcpAutoSetup(new AbortController().signal).catch((err: unknown) => {
        console.warn('[acp] auto-setup on workspace open failed:', err)
      })
    }
    return canonical
  })

  ipcMain.handle('workspace:is-trusted', () => isWorkspaceTrusted(getWorkspaceRoot()))
  ipcMain.handle('workspace:set-trusted', async (event, trusted: unknown) => {
    assertMainFrameSender(event, win)
    const root = getWorkspaceRoot()
    if (!root) throw new IpcValidationError('No workspace open')
    if (typeof trusted !== 'boolean') throw new IpcValidationError('trusted must be a boolean')
    if (trusted && !(await confirmNativeAction(event.sender, {
      title: 'Trust this workspace?',
      detail: `Trust ${root} and allow its project MCP servers to start? Project configuration can run commands with your account's access.`,
      approveLabel: 'Trust workspace',
    }))) throw new IpcValidationError('Workspace trust was not confirmed')
    const statuses = await setWorkspaceTrustAndReload(registry, root, trusted)
    broadcastToAppWindows('mcp:status-changed', statuses)
    return statuses
  })
}
