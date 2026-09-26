import { dialog, Menu, type BrowserWindow } from 'electron'
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

function showSharingIndicator(): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('mobile-companion')
  if (!item) return
  item.label = active?.isRunning()
    ? '● Mobile Companion On…'
    : preference?.current().enabled
      ? '● Mobile Companion Waiting…'
      : 'Mobile Companion…'
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
    message: 'Choose a phone to revoke its access.',
    detail:
      'Revoking access takes effect immediately. If you installed the Copse Local Root on that phone, remove it in the phone’s certificate settings too.',
    buttons: [...list.map((device) => device.label), 'Cancel'],
    defaultId: list.length,
    cancelId: list.length,
  })
  const selected = list[result.response]
  if (!selected) return
  devices.revoke(selected.id)
  await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Phone revoked',
    message: `${selected.label} can no longer read Copse from a phone.`,
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
      if (!win || win.isDestroyed() || quitting) return false
      const decision = await dialog.showMessageBox(win, {
        type: 'question',
        title: 'Pair a phone with Copse',
        message: `Does this code appear on ${label}?`,
        detail: `${code}\n\nApproving gives this phone read access to your thread names, saved messages, and activity whenever Mobile Companion is enabled. Only approve a phone you hold.`,
        buttons: ['Deny', 'Approve phone'],
        defaultId: 0,
        cancelId: 0,
      })
      return decision.response === 1
    },
    onStop: () => {
      active = null
      showSharingIndicator()
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
      showSharingIndicator()
      return server
    })
    .finally(() => {
      starting = null
    })
  return starting
}

/** Resume the user's enabled choice after every app start. */
export async function resumeMobileCompanion(): Promise<void> {
  if (quitting) return
  try {
    const choice = savedPreference().current()
    if (!choice.enabled || active?.isRunning()) return
    const addresses = mobileLanAddresses()
    const address =
      choice.address && addresses.includes(choice.address) ? choice.address : addresses[0]
    if (!address) {
      showSharingIndicator()
      scheduleRetry()
      return
    }
    await launch(address, new MobileDevices())
    if (address !== choice.address) savedPreference().enable(address)
  } catch (error) {
    console.error('[mobile] could not resume Mobile Companion:', error)
    showSharingIndicator()
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
      showSharingIndicator()
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
    message: 'Choose the local address to share with paired phones.',
    detail:
      'This opens an encrypted, read-only view. Pairing requires your approval on this Mac. Once enabled, Copse keeps the server running while the app is open and starts it again on launch. If this address changes, Copse may use another private address. Use this menu to turn it off.',
    buttons: [...addresses, 'Cancel'],
    defaultId: addresses.length,
    cancelId: addresses.length,
  })
  const address = addresses[choice.response]
  if (!address) return
  try {
    const server = await launch(address, devices)
    savedPreference().enable(address)
    showSharingIndicator()
    await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Mobile Companion is on',
      message: `Open ${server.url} on your phone.`,
      detail: `Transfer ${server.rootPath} directly to your phone and install it as a trusted certificate for a verified connection. This certificate can only vouch for private-network addresses, never a website. The phone may otherwise show a certificate warning. Use View → Mobile Companion to turn off sharing or revoke a phone.`,
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
