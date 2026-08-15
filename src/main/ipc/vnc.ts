import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { z } from 'zod'
import { getSetting } from '../services/storage/settings.ts'
import { getVncService, type VncConnectionOwner } from '../services/vnc/vnc-service.ts'
import { getVncUsername, rememberVncUsername } from '../services/vnc/vnc-username-store.ts'
import {
  assertMainFrameSender,
  parseIpcArgs,
  vncDiscoveryHostSchema,
  vncTargetSchema,
} from './ipc-guards.ts'

const vncConnectionIdSchema = z.uuid()
const vncUsernameSchema = z.string().trim().min(1).max(256)
const MAX_VNC_CLIENT_MESSAGE_BYTES = 1024 * 1024

function ownerFor(contents: WebContents): VncConnectionOwner {
  return {
    id: contents.id,
    isDestroyed: () => contents.isDestroyed(),
    send: (channel, ...args): void => {
      contents.send(channel, ...args)
    },
  }
}

function parseClientBytes(raw: unknown): Uint8Array {
  let bytes: Uint8Array
  if (raw instanceof Uint8Array) bytes = raw
  else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw)
  else throw new Error('VNC data must be binary')
  if (bytes.byteLength > MAX_VNC_CLIENT_MESSAGE_BYTES) {
    throw new Error('VNC client message exceeds the size limit')
  }
  return bytes
}

export function initVnc(win: BrowserWindow): () => Promise<void> {
  const service = getVncService()

  ipcMain.handle('vnc:open', async (event, rawTarget: unknown) => {
    assertMainFrameSender(event, win)
    if (!getSetting<boolean>('vncEnabled', false)) {
      throw new Error('VNC viewer is disabled in Settings')
    }
    const target = parseIpcArgs(vncTargetSchema, [rawTarget])
    if (target.kind === 'ssh' && !getSetting<boolean>('sshWorkspaceEnabled', false)) {
      throw new Error('Enable SSH workspaces in Settings before opening a remote desktop')
    }
    const connection = await service.open(target, ownerFor(event.sender))
    const ownerId = event.sender.id
    event.sender.once('destroyed', () => {
      void service.closeOwner(ownerId)
    })
    return connection
  })

  ipcMain.handle('vnc:list', (event) => {
    assertMainFrameSender(event, win)
    return service.list(event.sender.id)
  })

  ipcMain.handle('vnc:discover', async (event, rawHost: unknown) => {
    assertMainFrameSender(event, win)
    if (!getSetting<boolean>('vncEnabled', false)) {
      throw new Error('VNC viewer is disabled in Settings')
    }
    const host = parseIpcArgs(vncDiscoveryHostSchema, [rawHost])
    if (host.kind === 'ssh' && !getSetting<boolean>('sshWorkspaceEnabled', false)) {
      throw new Error('Enable SSH workspaces in Settings before discovering a remote desktop')
    }
    return service.discover(host)
  })

  ipcMain.handle('vnc:discover-nearby', async (event) => {
    assertMainFrameSender(event, win)
    if (!getSetting<boolean>('vncEnabled', false)) {
      throw new Error('VNC viewer is disabled in Settings')
    }
    return service.discoverNearby()
  })

  ipcMain.handle('vnc:get-username', (event, rawTarget: unknown) => {
    assertMainFrameSender(event, win)
    if (!getSetting<boolean>('vncEnabled', false)) {
      throw new Error('VNC viewer is disabled in Settings')
    }
    const target = parseIpcArgs(vncTargetSchema, [rawTarget])
    return getVncUsername(target)
  })

  ipcMain.handle(
    'vnc:remember-username',
    async (event, rawTarget: unknown, rawUsername: unknown) => {
      assertMainFrameSender(event, win)
      if (!getSetting<boolean>('vncEnabled', false)) {
        throw new Error('VNC viewer is disabled in Settings')
      }
      const [target, username] = parseIpcArgs(z.tuple([vncTargetSchema, vncUsernameSchema]), [
        rawTarget,
        rawUsername,
      ])
      return rememberVncUsername(target, username)
    },
  )

  ipcMain.handle('vnc:close', async (event, rawId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(vncConnectionIdSchema, [rawId])
    await service.close(id, event.sender.id)
  })

  const onStart = (event: Electron.IpcMainEvent, rawId: unknown): void => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(vncConnectionIdSchema, [rawId])
    service.start(id, event.sender.id)
  }
  const onSend = (event: Electron.IpcMainEvent, rawId: unknown, rawBytes: unknown): void => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(vncConnectionIdSchema, [rawId])
    service.send(id, event.sender.id, parseClientBytes(rawBytes))
  }
  ipcMain.on('vnc:start', onStart)
  ipcMain.on('vnc:send', onSend)

  return async () => {
    ipcMain.removeHandler('vnc:open')
    ipcMain.removeHandler('vnc:list')
    ipcMain.removeHandler('vnc:discover')
    ipcMain.removeHandler('vnc:discover-nearby')
    ipcMain.removeHandler('vnc:get-username')
    ipcMain.removeHandler('vnc:remember-username')
    ipcMain.removeHandler('vnc:close')
    ipcMain.off('vnc:start', onStart)
    ipcMain.off('vnc:send', onSend)
    await service.closeAll()
  }
}
