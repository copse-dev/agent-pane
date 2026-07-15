import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { ensureTerminalPermitted } from '../services/security/permission-gate.ts'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zSessionId } from './ipc-guards.ts'
import {
  createTerminalSession,
  destroyAllTerminalSessions,
  destroyTerminalSession,
  resizeTerminalSession,
  setActiveTerminalSession,
  setTerminalSessionMeta,
  writeTerminalSession,
  type TerminalSessionMeta,
} from '../services/exec/terminal-service.ts'

const terminalCreateSchema = z.tuple([
  z.number().int().min(1).max(500),
  z.number().int().min(1).max(200),
  z
    .object({
      label: z.string().max(200).optional(),
      threadId: z.string().max(128).nullable().optional(),
    })
    .optional(),
])

const terminalMetaSchema = z.tuple([
  zSessionId,
  z.object({
    label: z.string().max(200).optional(),
    threadId: z.string().max(128).nullable().optional(),
  }),
])

function normalizeMeta(meta: {
  label?: string | undefined
  threadId?: string | null | undefined
}): TerminalSessionMeta {
  const out: TerminalSessionMeta = {}
  if (meta.label !== undefined) out.label = meta.label
  if (meta.threadId !== undefined) out.threadId = meta.threadId
  return out
}

export function initTerminal(win: BrowserWindow): () => void {
  ipcMain.handle('terminal:create', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [cols, rows, meta] = parseIpcArgs(terminalCreateSchema, rawArgs)
    const permitted = await ensureTerminalPermitted()
    if (!permitted) throw new Error('Terminal access was not approved')
    return createTerminalSession(
      win,
      event.sender.id,
      cols,
      rows,
      meta ? normalizeMeta(meta) : undefined,
    )
  })

  ipcMain.handle('terminal:write', (event, sessionId: unknown, data: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zSessionId, [sessionId])
    const payload = parseIpcArgs(z.string().max(65536), [data])
    writeTerminalSession(id, event.sender.id, payload)
  })

  ipcMain.handle('terminal:resize', (event, sessionId: unknown, cols: unknown, rows: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zSessionId, [sessionId])
    const [c, r] = parseIpcArgs(
      z.tuple([z.number().int().min(1).max(500), z.number().int().min(1).max(200)]),
      [cols, rows],
    )
    resizeTerminalSession(id, event.sender.id, c, r)
  })

  ipcMain.handle('terminal:destroy', (event, sessionId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zSessionId, [sessionId])
    destroyTerminalSession(id, event.sender.id)
  })

  ipcMain.handle('terminal:setMeta', (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [id, meta] = parseIpcArgs(terminalMetaSchema, rawArgs)
    setTerminalSessionMeta(id, event.sender.id, normalizeMeta(meta))
  })

  ipcMain.handle('terminal:setActive', (event, sessionId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(zSessionId, [sessionId])
    setActiveTerminalSession(id, event.sender.id)
  })

  const onWindowClose = (): void => {
    destroyAllTerminalSessions()
  }
  win.on('close', onWindowClose)

  return () => {
    win.off('close', onWindowClose)
    ipcMain.removeHandler('terminal:create')
    ipcMain.removeHandler('terminal:write')
    ipcMain.removeHandler('terminal:resize')
    ipcMain.removeHandler('terminal:destroy')
    ipcMain.removeHandler('terminal:setMeta')
    ipcMain.removeHandler('terminal:setActive')
    destroyAllTerminalSessions()
  }
}
