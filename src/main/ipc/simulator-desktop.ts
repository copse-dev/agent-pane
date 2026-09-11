import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { z } from 'zod'
import type { SimulatorDesktopOwner } from '../services/simulator-desktop/simulator-desktop-service.ts'
import { getSimulatorDesktopService } from '../services/simulator-desktop/simulator-desktop-service.ts'
import { getSetting } from '../services/storage/settings.ts'
import { AndroidDesktopService } from '../services/android-desktop/android-desktop-service.ts'
import { assertMainFrameSender, parseIpcArgs } from './ipc-guards.ts'

const connectionIdSchema = z.uuid()
const deviceUdidSchema = z.union([z.uuid(), z.string().regex(/^android:[1-9]\d{0,9}$/)])
const ratioSchema = z.number().min(0).max(1)
const inputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('touch'),
    phase: z.enum(['down', 'move', 'up']),
    x: ratioSchema,
    y: ratioSchema,
  }),
  z.object({
    type: z.literal('key-tap'),
    usage: z.number().int().min(4).max(231),
    modifiers: z.array(z.number().int().min(224).max(231)).max(4).optional(),
  }),
  z.object({
    type: z.literal('button-tap'),
    name: z.enum(['home', 'lock', 'side', 'siri', 'back', 'overview']),
  }),
])

function ownerFor(contents: WebContents): SimulatorDesktopOwner {
  return {
    id: contents.id,
    isDestroyed: () => contents.isDestroyed(),
    send: (channel, ...args): void => {
      contents.send(channel, ...args)
    },
  }
}

function requireDesktopEnabled(): void {
  if (!getSetting<boolean>('vncEnabled', false)) {
    throw new Error('Desktop viewer is disabled in Settings')
  }
}

export function initSimulatorDesktop(win: BrowserWindow): () => Promise<void> {
  const service = getSimulatorDesktopService()
  const android = new AndroidDesktopService()
  const serviceFor = (id: string): AndroidDesktopService | typeof service =>
    android.hasConnection(id) ? android : service

  ipcMain.handle('simulator-desktop:list', async (event) => {
    assertMainFrameSender(event, win)
    requireDesktopEnabled()
    // An Android-only developer may not have Xcode installed.
    const [simulators, emulators] = await Promise.all([
      service.listDevices().catch(() => []),
      android.listDevices(),
    ])
    return [...simulators, ...emulators]
  })
  ipcMain.handle('simulator-desktop:open', async (event, rawUdid: unknown) => {
    assertMainFrameSender(event, win)
    requireDesktopEnabled()
    const udid = parseIpcArgs(deviceUdidSchema, [rawUdid])
    const connection = await (udid.startsWith('android:') ? android : service).open(
      udid,
      ownerFor(event.sender),
    )
    const ownerId = event.sender.id
    event.sender.once('destroyed', () => {
      void service.closeOwner(ownerId)
      void android.closeOwner(ownerId)
    })
    return connection
  })
  ipcMain.handle('simulator-desktop:start', (event, rawId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(connectionIdSchema, [rawId])
    serviceFor(id).start(id, event.sender.id)
  })
  ipcMain.handle('simulator-desktop:input', (event, rawId: unknown, rawInput: unknown) => {
    assertMainFrameSender(event, win)
    const [id, input] = parseIpcArgs(z.tuple([connectionIdSchema, inputSchema]), [rawId, rawInput])
    return serviceFor(id).sendInput(id, event.sender.id, input)
  })
  ipcMain.handle('simulator-desktop:close', async (event, rawId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(connectionIdSchema, [rawId])
    await serviceFor(id).close(id, event.sender.id)
  })

  return async () => {
    ipcMain.removeHandler('simulator-desktop:list')
    ipcMain.removeHandler('simulator-desktop:open')
    ipcMain.removeHandler('simulator-desktop:start')
    ipcMain.removeHandler('simulator-desktop:input')
    ipcMain.removeHandler('simulator-desktop:close')
    await service.closeAll()
    await android.closeAll()
  }
}
