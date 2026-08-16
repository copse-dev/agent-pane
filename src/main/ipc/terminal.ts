import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { ensureTerminalPermitted } from '../services/security/permission-gate.ts'
import { resolveThreadExecutionContext } from '../services/thread-execution-context.ts'
import { getProjectRoot } from '../services/workspace.ts'
import { z } from 'zod'
import {
  assertMainFrameSender,
  parseIpcArgs,
  zProjectId,
  zSessionId,
  zThreadId,
} from './ipc-guards.ts'
import {
  createTerminalSession,
  destroyAllTerminalSessions,
  destroyTerminalSessionsForOwner,
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
  z.object({
    label: z.string().max(200).optional(),
    projectId: zProjectId,
    threadId: zThreadId.nullable(),
  }),
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

async function resolveTerminalRoot(meta: {
  projectId: string
  threadId: string | null
}): Promise<{ root: string; checkoutMode: 'shared' | 'worktree' }> {
  if (meta.threadId) {
    const context = await resolveThreadExecutionContext(meta.projectId, meta.threadId)
    return { root: context.root, checkoutMode: context.checkoutMode }
  }
  const projectRoot = getProjectRoot(meta.projectId)
  if (!projectRoot) throw new Error(`Cannot resolve root for project "${meta.projectId}"`)
  return { root: projectRoot, checkoutMode: 'shared' }
}

/**
 * Kill a renderer's shells when it goes away. Only the main window's `close` was
 * wired to teardown, so closing a pane pop-out left its ptys running with no UI
 * attached. Hooked once per owner, on its first session.
 */
const teardownHooked = new WeakSet<WebContents>()

function trackOwnerTeardown(sender: WebContents): void {
  if (teardownHooked.has(sender)) return
  teardownHooked.add(sender)
  sender.once('destroyed', () => {
    destroyTerminalSessionsForOwner(sender.id)
  })
}

export function initTerminal(win: BrowserWindow): () => void {
  ipcMain.handle('terminal:create', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [cols, rows, meta] = parseIpcArgs(terminalCreateSchema, rawArgs)
    const permitted = await ensureTerminalPermitted()
    if (!permitted) throw new Error('Terminal access was not approved')
    const execution = await resolveTerminalRoot(meta)
    // Route to the renderer that asked, not to the window captured at init.
    // Every other terminal op is already keyed on `event.sender.id`; only the
    // output target was not, so a pane pop-out's shell wrote to the main window
    // — which had no tab for that session and dropped it (#1705).
    trackOwnerTeardown(event.sender)
    const sessionId = await createTerminalSession(
      event.sender,
      cols,
      rows,
      normalizeMeta(meta),
      execution.root,
    )
    return { sessionId, checkoutMode: execution.checkoutMode }
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
