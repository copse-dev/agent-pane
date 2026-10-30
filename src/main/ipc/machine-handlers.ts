import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { machineSharingSchema } from '@shared/machines.ts'
import { assertMainFrameSender, parseIpcArgs } from './ipc-guards.ts'
import { machineManager } from '../services/machines/machine-service.ts'

export function registerMachineHandlers(win: BrowserWindow): void {
  ipcMain.handle('machines:state', async (event) => {
    assertMainFrameSender(event, win)
    const manager = machineManager()
    await manager.refresh()
    return manager.snapshot()
  })
  ipcMain.handle('machines:pair', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return machineManager().pair(parseIpcArgs(z.string().min(1).max(2048), [raw]))
  })
  ipcMain.handle('machines:remove', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return machineManager().remove(parseIpcArgs(z.uuid(), [raw]))
  })
  ipcMain.handle('machines:share', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return machineManager().share(parseIpcArgs(machineSharingSchema, [raw]))
  })
  ipcMain.handle('machines:invitation', (event) => {
    assertMainFrameSender(event, win)
    return machineManager().invitation()
  })
  ipcMain.handle('machines:revoke', (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    return machineManager().revoke(parseIpcArgs(z.uuid(), [raw]))
  })
}
