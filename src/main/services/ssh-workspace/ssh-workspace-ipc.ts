import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { SshConnectionState } from '@shared/types/ssh-workspace.ts'
import {
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  zPathString,
  zSshHostId,
} from '../../ipc/ipc-guards.ts'
import { readSshConfigAliases } from './ssh-config.ts'
import { hostFromSshConfigAlias, listConfiguredSshHosts } from './hosts.ts'
import { getSshConnectionManager } from './connection-manager.ts'
import { listRemoteDirectory, registerRemoteWorkspaceRoot } from './remote-directory.ts'
import { z } from 'zod'
import { forgetSshCredentials } from './ssh-credential-cache.ts'
import { listStoredSshCredentialHostIds } from './ssh-credential-store.ts'

const sshBrowseSchema = z.tuple([zSshHostId, zPathString])

export function initSshWorkspaceIpc(win: BrowserWindow): void {
  const manager = getSshConnectionManager()

  const pushStates = (states: SshConnectionState[]): void => {
    if (!win.isDestroyed()) win.webContents.send('ssh:connection_changed', states)
  }

  manager.onChange(pushStates)

  ipcMain.handle('sshWorkspace:listHosts', (event) => {
    assertMainFrameSender(event, win)
    return listConfiguredSshHosts()
  })

  ipcMain.handle('sshWorkspace:listConfigAliases', (event) => {
    assertMainFrameSender(event, win)
    return readSshConfigAliases().map(hostFromSshConfigAlias)
  })

  ipcMain.handle('sshWorkspace:getStates', (event) => {
    assertMainFrameSender(event, win)
    return manager.listStates()
  })

  ipcMain.handle('sshWorkspace:listCredentialHostIds', (event) => {
    assertMainFrameSender(event, win)
    return listStoredSshCredentialHostIds()
  })

  ipcMain.handle('sshWorkspace:forgetCredentials', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const hostId = parseIpcArgs(zSshHostId, rawArgs)
    // End the live ControlMaster too: otherwise OpenSSH would keep using an
    // already-authenticated connection after the user explicitly forgot it.
    try {
      await manager.disconnect(hostId)
    } catch (error) {
      console.warn(
        `[copse-panel] could not disconnect SSH host ${hostId} while forgetting authentication:`,
        error instanceof Error ? error.message : error,
      )
    }
    forgetSshCredentials(hostId)
  })

  ipcMain.handle('sshWorkspace:connect', async (event, ...rawArgs) => {
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

  ipcMain.handle('sshWorkspace:disconnect', async (event, ...rawArgs) => {
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

  ipcMain.handle('sshWorkspace:reconnect', async (event, ...rawArgs) => {
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

  ipcMain.handle('sshWorkspace:listDirectory', async (event, ...rawArgs) => {
    try {
      assertMainFrameSender(event, win)
      const [hostId, dirPath] = parseIpcArgs(sshBrowseSchema, rawArgs)
      return await listRemoteDirectory(hostId, dirPath)
    } catch (err) {
      if (err instanceof IpcValidationError) throw err
      throw err
    }
  })

  ipcMain.handle('sshWorkspace:registerRoot', async (event, ...rawArgs) => {
    try {
      assertMainFrameSender(event, win)
      const [hostId, dirPath] = parseIpcArgs(sshBrowseSchema, rawArgs)
      return await registerRemoteWorkspaceRoot(hostId, dirPath)
    } catch (err) {
      if (err instanceof IpcValidationError) throw err
      throw err
    }
  })
}
