import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { defineHandler } from './define-handler.ts'
import { zProjectId, zThreadId } from './ipc-guards.ts'
import {
  exportDecisionLog,
  readDecisionLog,
  readThreadDecisionLog,
} from '../services/security/decision-log-store.ts'

export function registerDecisionHandlers(win: BrowserWindow): void {
  // Durable permission-decision audit log (#656). The caller names the project;
  // without one there is nothing to read. The window's active project is not
  // main's to guess.
  defineHandler(win, 'decisions:list', z.tuple([zProjectId.optional()]), (projectId) =>
    projectId === undefined ? [] : readDecisionLog(projectId),
  )
  defineHandler(win, 'decisions:list-thread', z.tuple([zProjectId, zThreadId]), (pid, tid) =>
    readThreadDecisionLog(pid, tid),
  )
  defineHandler(win, 'decisions:export', z.tuple([zProjectId.optional()]), (projectId) => {
    if (projectId === undefined) throw new Error('No project to export decisions for.')
    return exportDecisionLog(projectId)
  })
}
