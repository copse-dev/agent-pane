import { BrowserWindow, ipcMain } from 'electron'
import { assertMainFrameSender, parsePortKillArgs } from './ipc-guards.ts'
import { killOwnedPort, listPortRows } from '../services/ports/ports-registry.ts'

export function registerPortHandlers(win: BrowserWindow): void {
  // Ports panel. Listening ports are discovered by scanning the host, not by
  // tracking what Copse spawned, so the list includes the user's other apps and
  // system services — visibility over enforcement, per #771. Only rows that
  // descend from a Shells tab or a background task can be killed, and that is
  // decided in `killOwnedPort` from a fresh scan rather than from anything the
  // renderer sends.
  ipcMain.handle('ports:list', (event) => {
    assertMainFrameSender(event, win)
    return listPortRows()
  })

  ipcMain.handle('ports:kill', (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const port = parsePortKillArgs(rawArgs)
    return killOwnedPort(port)
  })
}
