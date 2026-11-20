import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { getProjectRoot } from '../services/workspace.ts'
import {
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  zPathString,
  zProjectId,
} from './ipc-guards.ts'
import { openWorkspaceInExternalEditor } from '../services/editors/editor-launcher.ts'
import { listRunningThreadIds } from '../services/agent-service.ts'
import {
  listWorktreeInventory,
  cleanupWorktreePackages,
  measureWorktreeSize,
  removeWorktree,
  resolveRegisteredWorktreePath,
} from '../services/worktree-inventory.ts'

export function registerWorktreeHandlers(win: BrowserWindow): void {
  // Settings → Sources → Worktrees. Every call names the project by id and the
  // main process resolves its root itself, so the renderer never gets to say
  // which repository (or which directory) is operated on.
  const worktreeInput = (
    rawProjectId: unknown,
  ): { projectId: string; projectRoot: string } | null => {
    const projectId = parseIpcArgs(zProjectId, [rawProjectId])
    const projectRoot = getProjectRoot(projectId)
    return projectRoot === null ? null : { projectId, projectRoot }
  }

  ipcMain.handle('worktrees:list', async (event, rawProjectId: unknown) => {
    assertMainFrameSender(event, win)
    const target = worktreeInput(rawProjectId)
    if (!target) return []
    return listWorktreeInventory({
      ...target,
      runningThreadIds: new Set(listRunningThreadIds()),
    })
  })

  ipcMain.handle('worktrees:size', async (event, rawProjectId: unknown, rawPath: unknown) => {
    assertMainFrameSender(event, win)
    const [, path] = parseIpcArgs(z.tuple([zProjectId, zPathString]), [rawProjectId, rawPath])
    const target = worktreeInput(rawProjectId)
    if (!target) throw new IpcValidationError('That project is no longer available')
    return measureWorktreeSize({ ...target, path })
  })

  ipcMain.handle(
    'worktrees:cleanup-packages',
    async (event, rawProjectId: unknown, rawPath: unknown, rawRemove: unknown) => {
      assertMainFrameSender(event, win)
      const [, path, remove] = parseIpcArgs(z.tuple([zProjectId, zPathString, z.boolean()]), [
        rawProjectId,
        rawPath,
        rawRemove,
      ])
      const target = worktreeInput(rawProjectId)
      if (!target) throw new IpcValidationError('That project is no longer available')
      return cleanupWorktreePackages({
        ...target,
        path,
        remove,
        runningThreadIds: new Set(listRunningThreadIds()),
      })
    },
  )

  ipcMain.handle(
    'worktrees:open-terminal',
    async (event, rawProjectId: unknown, rawPath: unknown) => {
      assertMainFrameSender(event, win)
      const [, path] = parseIpcArgs(z.tuple([zProjectId, zPathString]), [rawProjectId, rawPath])
      const target = worktreeInput(rawProjectId)
      if (!target) throw new IpcValidationError('That project is no longer available')
      const root = await resolveRegisteredWorktreePath({ ...target, path })
      return openWorkspaceInExternalEditor('terminal', root)
    },
  )

  ipcMain.handle(
    'worktrees:remove',
    async (event, rawProjectId: unknown, rawPath: unknown, rawForce: unknown) => {
      assertMainFrameSender(event, win)
      const [, path, force] = parseIpcArgs(z.tuple([zProjectId, zPathString, z.boolean()]), [
        rawProjectId,
        rawPath,
        rawForce,
      ])
      const target = worktreeInput(rawProjectId)
      if (!target) throw new IpcValidationError('That project is no longer available')
      return removeWorktree({
        ...target,
        path,
        force,
        runningThreadIds: new Set(listRunningThreadIds()),
      })
    },
  )
}
