import { ipcMain, shell, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { assertMainFrameSender, IpcValidationError, parseIpcArgs } from './ipc-guards.ts'
import { confirmNativeAction } from '../services/native-human-confirmation.ts'
import {
  mobileDeviceAccessArgsSchema,
  mobileInviteSchema,
  mobilePairingArgsSchema,
} from './mobile-companion-args.ts'
import {
  disableMobileCompanion,
  enableMobileCompanion,
  getMobileCompanionState,
  recheckMobilePublicNameDns,
  registerMobilePublicName,
  removeMobilePublicName,
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
    if (
      !(await confirmNativeAction(event.sender, {
        title: 'Enable Mobile Companion?',
        detail: `Listen for mobile devices on ${address}. Device access still requires separate approval.`,
        approveLabel: 'Enable',
      }))
    ) {
      throw new IpcValidationError('Mobile Companion was not confirmed')
    }
    await enableMobileCompanion(address)
  })
  ipcMain.handle('mobile:disable', async (event) => {
    assertMainFrameSender(event, win)
    await disableMobileCompanion()
  })
  ipcMain.handle('mobile:set-device-access', async (event, ...args) => {
    assertMainFrameSender(event, win)
    const [id, access] = parseIpcArgs(mobileDeviceAccessArgsSchema, args)
    if (
      !(await confirmNativeAction(event.sender, {
        title: 'Change mobile device access?',
        detail: `Give device ${id} ${access} access to Copse?`,
        approveLabel: 'Grant access',
      }))
    ) {
      throw new IpcValidationError('Mobile device access was not confirmed')
    }
    setMobileDeviceAccess(id, access)
  })
  ipcMain.handle('mobile:revoke-device', (event, rawId: unknown) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(mobileDeviceIdSchema, [rawId])
    revokeMobileDevice(id)
  })
  ipcMain.handle('mobile:respond-pairing', async (event, ...args) => {
    assertMainFrameSender(event, win)
    const [decision, code, pairingId, rootTrusted] = parseIpcArgs(mobilePairingArgsSchema, args)
    if (
      decision !== 'deny' &&
      !(await confirmNativeAction(event.sender, {
        title: 'Pair mobile device?',
        detail: `Pairing code: ${code}\nDevice request: ${pairingId}\nAccess: ${decision}\nLocal root acknowledged: ${rootTrusted === true ? 'yes' : 'no'}`,
        approveLabel: 'Pair device',
      }))
    ) {
      throw new IpcValidationError('Mobile pairing was not confirmed')
    }
    respondToMobilePairing(decision, code, pairingId, rootTrusted === true)
  })
  ipcMain.handle('mobile:register-name', async (event, rawInvite: unknown) => {
    assertMainFrameSender(event, win)
    const invite = parseIpcArgs(mobileInviteSchema, [rawInvite])
    if (
      !(await confirmNativeAction(event.sender, {
        title: 'Register a public mobile name?',
        detail: 'Register this device for public name access to Mobile Companion?',
        approveLabel: 'Register name',
      }))
    ) {
      throw new IpcValidationError('Mobile name registration was not confirmed')
    }
    await registerMobilePublicName(invite)
  })
  ipcMain.handle('mobile:remove-name', async (event) => {
    assertMainFrameSender(event, win)
    await removeMobilePublicName()
  })
  ipcMain.handle('mobile:recheck-name-dns', async (event) => {
    assertMainFrameSender(event, win)
    await recheckMobilePublicNameDns()
  })
  ipcMain.handle('mobile:reveal-certificate', (event) => {
    assertMainFrameSender(event, win)
    const path = getMobileCompanionState().rootCertificatePath
    if (path) shell.showItemInFolder(path)
  })
}
