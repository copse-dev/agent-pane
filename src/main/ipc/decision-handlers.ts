import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { defineHandler } from './define-handler.ts'
import { zProjectId, zThreadId } from './ipc-guards.ts'
import { getActiveProjectId } from '../services/workspace.ts'
import {
  exportDecisionLog,
  readDecisionLog,
  readThreadDecisionLog,
} from '../services/security/decision-log-store.ts'

export function registerDecisionHandlers(win: BrowserWindow): void {
  // Durable permission-decision audit log (#656). `projectId` is optional — an
  // empty/absent value falls back to the active project.
  defineHandler(win, 'decisions:list', z.tuple([zProjectId.optional()]), (projectId) => {
    const resolved = projectId ?? getActiveProjectId()
    if (!resolved) return []
    return readDecisionLog(resolved)
  })
  defineHandler(win, 'decisions:list-thread', z.tuple([zProjectId, zThreadId]), (pid, tid) =>
    readThreadDecisionLog(pid, tid),
  )
  defineHandler(win, 'decisions:export', z.tuple([zProjectId.optional()]), (projectId) => {
    const resolved = projectId ?? getActiveProjectId()
    if (!resolved) throw new Error('No project to export decisions for.')
    return exportDecisionLog(resolved)
  })
}
