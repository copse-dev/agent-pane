import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { getWorkspaceRoot } from '../services/workspace.ts'
import {
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  zHookRunId,
  zHookTestRequest,
  zProjectId,
  zThreadId,
} from './ipc-guards.ts'
import { resolveHookTestTarget } from './hook-test-target.ts'
import type { HooksListResult } from '@shared/types/hooks.ts'
import { setSetting } from '../services/storage/settings.ts'
import { createSkillRootsHandler } from './skill-roots-handler.ts'
import {
  listSkills,
  listSkillSources,
  initSkillsRegistry,
  waitForSkillsRegistryRefresh,
} from '../services/skills/skills-registry.ts'
import { listAgents, waitForAgentsRegistryRefresh } from '../services/agents/agents-registry.ts'
import { listCursorPlugins } from '../services/skills/cursor-plugins.ts'
import { listBundledSkillPlugins } from '../services/skills/bundled-cursor-skills.ts'
import { listCursorHooksForSources } from '../services/hooks/cursor-adapter.ts'
import { listClaudeHooks } from '../services/hooks/claude-adapter.ts'
import { listCopseHooksForSources } from '../services/hooks/copse-adapter.ts'
import { dryRunHook } from '../services/hooks/dry-run.ts'
import { readHookRunDetail } from '../services/hooks/run-detail.ts'
import { senderProjectRoot } from './sender-project-root.ts'
import { isWorkspaceTrusted } from '../services/security/workspace-trust.ts'

export function registerCustomizationHandlers(win: BrowserWindow): void {
  ipcMain.handle('skills:list', async (event) => {
    assertMainFrameSender(event, win)
    await waitForSkillsRegistryRefresh()
    return listSkills()
  })
  ipcMain.handle('skills:sources', async (event) => {
    assertMainFrameSender(event, win)
    await initSkillsRegistry()
    return listSkillSources()
  })
  ipcMain.handle(
    'skills:set-roots',
    createSkillRootsHandler(win, { setSetting, initSkillsRegistry, listSkillSources }),
  )
  ipcMain.handle('agents:list', async (event) => {
    assertMainFrameSender(event, win)
    await waitForAgentsRegistryRefresh()
    return listAgents()
  })
  ipcMain.handle('cursor-plugins:list', (event) => {
    assertMainFrameSender(event, win)
    return listCursorPlugins()
  })
  ipcMain.handle('bundled-skill-plugins:list', (event) => {
    assertMainFrameSender(event, win)
    return listBundledSkillPlugins()
  })
  async function listDiscoveredHooks(): Promise<HooksListResult> {
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
  }
  ipcMain.handle('hooks:list', (event) => {
    assertMainFrameSender(event, win)
    return listDiscoveredHooks()
  })
  ipcMain.handle('hooks:test', async (event, rawReq: unknown) => {
    assertMainFrameSender(event, win)
    // G2 dry-run tester: run one discovered hook once against a synthetic
    // payload and report stdin/stdout/stderr/exit/duration. `dryRunHook` is a
    // side-effect-free probe — it never records the spine, propagates session
    // env, or applies the outcome (see dry-run.ts). The renderer only names
    // the hook: what is spawned (command, cwd, sandbox escape) comes from
    // re-running discovery here, so a compromised renderer cannot run an
    // arbitrary command or turn the sandbox off.
    const parsed = parseIpcArgs(zHookTestRequest, [rawReq])
    const target = resolveHookTestTarget(parsed, (await listDiscoveredHooks()).hooks)
    if (!target) throw new IpcValidationError('Hook test rejected: not a discovered hook')
    return dryRunHook(target, senderProjectRoot(event.sender))
  })
  // Read one recorded hook execution back out of a thread's spine so the
  // hook-card inspector can show what the hook was handed and what it returned.
  // Read-only: it never re-runs anything (that is `hooks:test`), and the ids are
  // validated so a compromised renderer cannot walk out of the chat store.
  ipcMain.handle(
    'hooks:run-detail',
    (event, rawProjectId: unknown, rawThreadId: unknown, rawRunId: unknown) => {
      assertMainFrameSender(event, win)
      const [projectId, threadId, runId] = parseIpcArgs(
        z.tuple([zProjectId, zThreadId, zHookRunId]),
        [rawProjectId, rawThreadId, rawRunId],
      )
      return readHookRunDetail(projectId, threadId, runId)
    },
  )
}
