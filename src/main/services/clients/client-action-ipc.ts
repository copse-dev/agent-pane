import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, IpcValidationError } from '../../ipc/ipc-guards.ts'
import { clientActionOfferSchema, type ClientActionCommand } from '@shared/client-actions.ts'
import { clientActions } from './client-actions.ts'

export function initClientActions(win: BrowserWindow, ipcMain: IpcMain): void {
  const owner = win.webContents.id
  const assertOwner = (event: IpcMainInvokeEvent): void => {
    assertMainFrameSender(event, win)
    if (
      win.isDestroyed() ||
      event.sender.id !== owner ||
      event.senderFrame !== win.webContents.mainFrame
    ) {
      throw new IpcValidationError('Action publication belongs to another window')
    }
  }
  const pending = new Map<string, { settle: (accepted: boolean) => void; claim: () => boolean }>()
  const clear = (): void => {
    clientActions.clear(owner)
    for (const entry of pending.values()) entry.settle(false)
  }
  win.webContents.on('render-process-gone', clear)
  win.webContents.on('did-start-loading', clear)
  win.once('closed', clear)
  ipcMain.handle('client-actions:publish', (event, ...args) => {
    assertOwner(event)
    const offer = parseIpcArgs(clientActionOfferSchema.nullable(), args)
    clientActions.publish(
      owner,
      offer,
      (reference, authorized) =>
        new Promise((resolve) => {
          if (win.isDestroyed() || !authorized()) {
            resolve(false)
            return
          }
          const id = randomUUID()
          const expiresAt = Date.now() + 3000
          const timer = setTimeout(() => pending.get(id)?.settle(false), 3000)
          let claimed = false
          pending.set(id, {
            claim: (): boolean => {
              if (claimed || Date.now() >= expiresAt || !authorized()) return false
              claimed = true
              return true
            },
            settle: (accepted): void => {
              pending.delete(id)
              clearTimeout(timer)
              resolve(accepted && claimed)
            },
          })
          win.webContents.send('client-actions:invoke', {
            ...reference,
            id,
            expiresAt,
          } satisfies ClientActionCommand)
        }),
    )
  })
  ipcMain.handle('client-actions:claim', (event, ...args) => {
    assertOwner(event)
    const id = parseIpcArgs(z.uuid(), args)
    return pending.get(id)?.claim() ?? false
  })
  ipcMain.handle('client-actions:reply', (event, ...args) => {
    assertOwner(event)
    const [id, accepted] = parseIpcArgs(z.tuple([z.uuid(), z.boolean()]), args)
    pending.get(id)?.settle(accepted)
  })
}
