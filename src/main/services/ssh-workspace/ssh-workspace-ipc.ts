import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { SshConnectionState } from '@shared/types/ssh-workspace.ts'
import {
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  zSshHostId,
} from '../../ipc/ipc-guards.ts'
import { readSshConfigAliases } from './ssh-config.ts'
import { hostFromSshConfigAlias, listConfiguredSshHosts } from './hosts.ts'
import { getSshConnectionManager } from './connection-manager.ts'

export function initSshWorkspaceIpc(win: BrowserWindow): void {
  const manager = getSshConnectionManager()

  const pushStates = (states: SshConnectionState[]): void => {
    if (!win.isDestroyed()) win.webContents.send('ssh:connection_changed', states)
  }

  manager.onChange(pushStates)

  ipcMain.handle('ssh-workspace:listHosts', (event) => {
    assertMainFrameSender(event, win)
    return listConfiguredSshHosts()
  })

  ipcMain.handle('ssh-workspace:listConfigAliases', (event) => {
    assertMainFrameSender(event, win)
    return readSshConfigAliases().map(hostFromSshConfigAlias)
  })

  ipcMain.handle('ssh-workspace:getStates', (event) => {
    assertMainFrameSender(event, win)
    return manager.listStates()
  })

  ipcMain.handle('ssh-workspace:connect', async (event, ...rawArgs) => {
    try {
      assertMainFrameSender(event, win)
      const hostId = parseIpcArgs(zSshHostId, rawArgs)
      await manager.connect(hostId)
      return manager.listStates()
    } catch (err) {
      if (err instanceof IpcValidationError) throw err
      throw err
    }
  })

  ipcMain.handle('ssh-workspace:disconnect', async (event, ...rawArgs) => {
    try {
      assertMainFrameSender(event, win)
      const hostId = parseIpcArgs(zSshHostId, rawArgs)
      await manager.disconnect(hostId)
      return manager.listStates()
    } catch (err) {
      if (err instanceof IpcValidationError) throw err
      throw err
    }
  })

  ipcMain.handle('ssh-workspace:reconnect', async (event, ...rawArgs) => {
    try {
      assertMainFrameSender(event, win)
      const hostId = parseIpcArgs(zSshHostId, rawArgs)
      await manager.reconnect(hostId)
      return manager.listStates()
    } catch (err) {
      if (err instanceof IpcValidationError) throw err
      throw err
    }
  })
}
