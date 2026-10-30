import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zProjectId, zThreadId } from './ipc-guards.ts'
import { getActiveProjectId } from '../services/workspace.ts'
import {
  exportDecisionLog,
  readDecisionLog,
  readThreadDecisionLog,
} from '../services/security/decision-log-store.ts'

export function registerDecisionHandlers(win: BrowserWindow): void {
  // Durable permission-decision audit log (#656). `projectId` is optional — an
  // empty/absent value falls back to the active project.
  ipcMain.handle('decisions:list', (event, rawProjectId: unknown) => {
    assertMainFrameSender(event, win)
    const projectId = parseIpcArgs(zProjectId.optional(), [rawProjectId])
    const resolved = projectId ?? getActiveProjectId()
    if (!resolved) return []
    return readDecisionLog(resolved)
  })
  ipcMain.handle('decisions:list-thread', (event, projectId: unknown, threadId: unknown) => {
    assertMainFrameSender(event, win)
    const [pid, tid] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
    return readThreadDecisionLog(pid, tid)
  })
  ipcMain.handle('decisions:export', (event, rawProjectId: unknown) => {
    assertMainFrameSender(event, win)
    const projectId = parseIpcArgs(zProjectId.optional(), [rawProjectId])
    const resolved = projectId ?? getActiveProjectId()
    if (!resolved) throw new Error('No project to export decisions for.')
    return exportDecisionLog(resolved)
  })
}
