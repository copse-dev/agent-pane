import { ipcMain, shell, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs } from './ipc-guards.ts'
import { mobileDeviceAccessArgsSchema, mobilePairingArgsSchema } from './mobile-companion-args.ts'
import {
  disableMobileCompanion,
  enableMobileCompanion,
  getMobileCompanionState,
  respondToMobilePairing,
  revokeMobileDevice,
  setMobileDeviceAccess,
} from '../services/mobile/mobile-companion-service.ts'

const mobileAddressSchema = z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}$/)
const mobileDeviceIdSchema = z.uuid()

export function registerMobileHandlers(win: BrowserWindow): void {
  ipcMain.handle('mobile:get-state', (event) => {
    assertMainFrameSender(event, win)
    return getMobileCompanionState()
  })
  ipcMain.handle('mobile:enable', async (event, rawAddress: unknown) => {
    assertMainFrameSender(event, win)
    const address = parseIpcArgs(mobileAddressSchema, [rawAddress])
    await enableMobileCompanion(address)
  })
  ipcMain.handle('mobile:disable', async (event) => {
    assertMainFrameSender(event, win)
    await disableMobileCompanion()
  })
  ipcMain.handle('mobile:set-device-access', (event, ...args) => {
    assertMainFrameSender(event, win)
    const [id, access] = parseIpcArgs(mobileDeviceAccessArgsSchema, args)
    setMobileDeviceAccess(id, access)
  })
  ipcMain.handle('mobile:revoke-device', (event, rawId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(mobileDeviceIdSchema, [rawId])
    revokeMobileDevice(id)
  })
  ipcMain.handle('mobile:respond-pairing', (event, ...args) => {
    assertMainFrameSender(event, win)
    const [decision, code, pairingId] = parseIpcArgs(mobilePairingArgsSchema, args)
    respondToMobilePairing(decision, code, pairingId)
  })
  ipcMain.handle('mobile:reveal-certificate', (event) => {
    assertMainFrameSender(event, win)
    const path = getMobileCompanionState().rootCertificatePath
    if (path) shell.showItemInFolder(path)
  })
}
