import { dialog, type BrowserWindow } from 'electron'
import QRCode from 'qrcode'
import type { MobileCompanionStatus } from '../../shared/types/mobile-companion.ts'
import { MobileDevices } from '../services/mobile/mobile-devices.ts'
import { MobilePreference } from '../services/mobile/mobile-preference.ts'
import {
  mobileLanAddresses,
  startMobileServer,
  type MobileServer,
} from '../services/mobile/mobile-server.ts'
import { getFocusedMainWindow } from './create-main-window.ts'

let active: MobileServer | null = null
let preference: MobilePreference | null = null
let starting: Promise<MobileServer> | null = null
let retry: ReturnType<typeof setTimeout> | null = null
let quitting = false
let generation = 0
const RETRY_MS = 15_000

function savedPreference(): MobilePreference {
  preference ??= new MobilePreference()
  return preference
}

function clearRetry(): void {
  if (retry) clearTimeout(retry)
  retry = null
}

function scheduleRetry(): void {
  if (retry || quitting || !preference?.current().enabled) return
  retry = setTimeout(() => {
    retry = null
    void resumeMobileCompanion()
  }, RETRY_MS)
  retry.unref()
}

async function manageDevices(win: BrowserWindow, devices: MobileDevices): Promise<void> {
  const list = devices.list()
  if (list.length === 0) {
    await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Paired phones',
      message: 'No phones are paired.',
    })
    return
  }
  const result = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Paired phones',
    message: 'Choose a phone to manage its access.',
    detail:
      'Revoking access takes effect immediately. If you installed the Copse Local Root on that phone, remove it in the phone’s certificate settings too.',
    buttons: [...list.map((device) => device.label), 'Cancel'],
    defaultId: list.length,
    cancelId: list.length,
  })
  const selected = list[result.response]
  if (!selected) return
  const access = await dialog.showMessageBox(win, {
    type: 'question',
    title: selected.label,
    message: `Access: ${selected.access === 'control' ? 'Chat and run control' : 'Read only'}`,
    detail:
      'Control lets this phone send messages, start chats, stop runs, answer questions, and approve individual requests. Install and trust the Copse Local Root on the phone before enabling control. The browser cannot report its certificate trust settings to Copse.',
    checkboxLabel: 'The Copse Local Root is installed and trusted on this phone',
    checkboxChecked: false,
    buttons: [
      'Cancel',
      selected.access === 'control' ? 'Make read only' : 'Allow control',
      'Revoke phone',
    ],
    defaultId: 0,
    cancelId: 0,
  })
  if (access.response === 0) return
  if (access.response === 1) {
    if (selected.access === 'control') devices.setAccess(selected.id, 'read')
    else if (access.checkboxChecked) devices.setAccess(selected.id, 'control')
    else
      await dialog.showMessageBox(win, {
        type: 'info',
        message:
          'Install and trust the local certificate, then confirm the checkbox to allow control.',
      })
    return
  }
  devices.revoke(selected.id)
  await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Phone revoked',
    message: `${selected.label} can no longer access Copse.`,
  })
}

function launch(address: string, devices: MobileDevices): Promise<MobileServer> {
  if (starting) return starting
  const startedGeneration = generation
  starting = startMobileServer({
    address,
    devices,
    approvePair: async (label, code) => {
      const win = getFocusedMainWindow()
      if (!win || win.isDestroyed() || quitting) return null
      const decision = await dialog.showMessageBox(win, {
        type: 'question',
        title: 'Pair a phone with Copse',
        message: `Does this code appear on ${label}?`,
        detail: `${code}\n\nRead only shares thread names, saved messages, and activity. Allow control also lets this phone send messages, start chats, stop runs, answer questions, and approve individual requests. Only pair a phone you hold.`,
        checkboxLabel: 'The Copse Local Root is installed and trusted on this phone',
        checkboxChecked: false,
        buttons: ['Deny', 'Read only', 'Allow control'],
        defaultId: 0,
        cancelId: 0,
      })
      if (decision.response === 1) return 'read'
      if (decision.response === 2 && decision.checkboxChecked) return 'control'
      if (decision.response === 2)
        await dialog.showMessageBox(win, {
          type: 'info',
          message:
            'Pairing was declined. Install and trust the local certificate, then confirm the checkbox when pairing again.',
        })
      return null
    },
    onStop: () => {
      active = null
      scheduleRetry()
    },
  })
    .then(async (server) => {
      if (quitting || generation !== startedGeneration) {
        await server.close()
        throw new Error('Mobile Companion start was cancelled')
      }
      active = server
      clearRetry()
      return server
    })
    .finally(() => {
      starting = null
    })
  return starting
}

/** Current pairing state for Settings to render, including a scannable QR of the URL. */
export async function getMobileCompanionStatus(): Promise<MobileCompanionStatus> {
  const enabled = savedPreference().current().enabled
  const url = active?.isRunning() ? active.url : null
  const qrSvg = url ? await QRCode.toString(url, { type: 'svg', margin: 1 }) : null
  return { enabled, url, qrSvg }
}

/** Resume the user's enabled choice after every app start. */
export async function resumeMobileCompanion(): Promise<void> {
  if (quitting) return
  try {
    const choice = savedPreference().current()
    if (!choice.enabled || active?.isRunning()) return
    const addresses = mobileLanAddresses()
    const address =
      choice.address && addresses.some((candidate) => candidate.address === choice.address)
        ? choice.address
        : addresses[0]?.address
    if (!address) {
      scheduleRetry()
      return
    }
    await launch(address, new MobileDevices())
    if (address !== choice.address) savedPreference().enable(address)
  } catch (error) {
    console.error('[mobile] could not resume Mobile Companion:', error)
    scheduleRetry()
  }
}

export async function showMobileCompanion(win: BrowserWindow): Promise<void> {
  let devices: MobileDevices
  let enabled: boolean
  try {
    devices = active?.devices ?? new MobileDevices()
    enabled = savedPreference().current().enabled
  } catch (error) {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Mobile Companion unavailable',
      message: error instanceof Error ? error.message : String(error),
    })
    return
  }
  if (enabled) {
    const liveServer = active?.isRunning() ? active : null
    const result = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Mobile Companion',
      message: liveServer
        ? 'Your desktop is available on your local network.'
        : 'Mobile Companion is enabled, but its local server is not running yet.',
      detail: liveServer
        ? `Open ${liveServer.url} on your phone.\n\nThe trust certificate is at ${liveServer.rootPath}. Transfer it directly to your phone to install it. It can only vouch for private-network addresses, never a website. Remove it from your phone’s certificate settings when you no longer need it.\n\nCopse must stay open and this Mac must stay awake. Sharing starts again automatically when Copse restarts.`
        : 'Copse will retry automatically while it is open and will start Mobile Companion on its next launch. Check that this Mac has a private Wi-Fi or wired address and that the companion port is available.',
      buttons: ['Close', 'Manage paired phones', 'Turn off Mobile Companion'],
      defaultId: 0,
      cancelId: 0,
    })
    if (result.response === 1) await manageDevices(win, devices)
    if (result.response === 2) {
      generation += 1
      savedPreference().disable()
      clearRetry()
      await active?.close()
      active = null
    }
    return
  }
  const addresses = mobileLanAddresses()
  if (addresses.length === 0) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Mobile Companion',
      message: 'Connect this Mac to a private Wi-Fi or wired network first.',
    })
    return
  }
  const choice = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Enable Mobile Companion',
    message: 'Choose the network your phone is using.',
    detail:
      'Each address belongs to a different network interface. Usually choose Wi-Fi (often en0) when your phone is on Wi-Fi, or the wired interface when both devices use that network. VPN and virtual-machine interfaces may not be reachable unless your phone also joins that network. Copse being “on” only means the listener started; macOS or Wi-Fi client isolation can still block the phone.\n\nThis opens an encrypted companion for your threads. Pairing and phone control require your approval on this Mac.',
    buttons: [
      ...addresses.map(({ interfaceName, address }) => `${interfaceName} — ${address}`),
      'Cancel',
    ],
    defaultId: addresses.length,
    cancelId: addresses.length,
  })
  const selected = addresses[choice.response]
  if (!selected) return
  const { address } = selected
  try {
    const server = await launch(address, devices)
    savedPreference().enable(address)
    await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Mobile Companion is on',
      message: `Open ${server.url} on your phone.`,
      detail: `Keep both devices on the same local network. If the page does not open, check System Settings → Privacy & Security → Local Network and allow Copse, then check that the Wi-Fi does not isolate devices.\n\nTransfer ${server.rootPath} directly to your phone and install it as a trusted certificate for a verified connection. This certificate can only vouch for private-network addresses, never a website. The phone may otherwise show a certificate warning. Manage or turn off sharing in Settings → Experimental.`,
    })
  } catch (error) {
    await active?.close()
    active = null
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Mobile Companion could not start',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function stopMobileCompanion(): Promise<void> {
  quitting = true
  generation += 1
  clearRetry()
  await active?.close()
  active = null
}
