import QRCode from 'qrcode'
import type {
  MobileCompanionAccess,
  MobileCompanionState,
} from '../../../shared/types/mobile-companion.ts'
import { broadcastToAppWindows } from '../../windows/app-window-broadcast.ts'
import { MobileDevices } from './mobile-devices.ts'
import { MobilePreference } from './mobile-preference.ts'
import { mobileLanAddresses, startMobileServer, type MobileServer } from './mobile-server.ts'

let active: MobileServer | null = null
let preference: MobilePreference | null = null
let deviceStore: MobileDevices | null = null
let starting: Promise<MobileServer> | null = null
let retry: ReturnType<typeof setTimeout> | null = null
let quitting = false
let generation = 0
let lastError: string | null = null
let qrCache: { url: string; svg: string } | null = null
let pendingPairing: {
  label: string
  code: string
  resolve: (decision: MobileCompanionAccess | null) => void
} | null = null
const RETRY_MS = 15_000

function savedPreference(): MobilePreference {
  preference ??= new MobilePreference()
  return preference
}

function devices(): MobileDevices {
  deviceStore ??= new MobileDevices()
  return deviceStore
}

function publish(): void {
  broadcastToAppWindows('mobile:state-changed', getMobileCompanionState())
}

/**
 * The QR is a convenience, not a trust proof — it carries no claim about
 * bundle integrity, it just saves typing `url` into the phone's browser. It
 * is generated lazily and cached per URL; a cache miss republishes state once
 * generation finishes instead of blocking this synchronous read.
 */
function currentQrSvg(url: string | null): string | null {
  if (!url) return null
  if (qrCache?.url === url) return qrCache.svg
  void QRCode.toString(url, { type: 'svg', margin: 1 })
    .then((svg) => {
      qrCache = { url, svg }
      publish()
    })
    .catch((error: unknown) => {
      console.error('[mobile] could not generate the pairing QR:', error)
    })
  return null
}

export function getMobileCompanionState(): MobileCompanionState {
  const running = active?.isRunning() ?? false
  const url = running ? (active?.url ?? null) : null
  return {
    enabled: savedPreference().current().enabled,
    running,
    url,
    qrSvg: currentQrSvg(url),
    rootCertificatePath: running ? (active?.rootPath ?? null) : null,
    addresses: mobileLanAddresses(),
    devices: devices().list(),
    pairing: pendingPairing ? { label: pendingPairing.label, code: pendingPairing.code } : null,
    lastError,
  }
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

/** The one in-flight pairing a phone can have; Settings shows and resolves it. */
function approvePair(label: string, code: string): Promise<MobileCompanionAccess | null> {
  return new Promise((resolve) => {
    pendingPairing = { label, code, resolve }
    publish()
  })
}

export function respondToMobilePairing(decision: MobileCompanionAccess | 'deny'): void {
  if (!pendingPairing) return
  const { resolve } = pendingPairing
  pendingPairing = null
  resolve(decision === 'deny' ? null : decision)
  publish()
}

function launch(address: string): Promise<MobileServer> {
  if (starting) return starting
  const startedGeneration = generation
  starting = startMobileServer({
    address,
    devices: devices(),
    approvePair,
    onStop: () => {
      active = null
      scheduleRetry()
      publish()
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
    await launch(address)
    if (address !== choice.address) savedPreference().enable(address)
    lastError = null
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    console.error('[mobile] could not resume Mobile Companion:', error)
    scheduleRetry()
  }
  publish()
}

export async function enableMobileCompanion(address: string): Promise<void> {
  try {
    await launch(address)
    savedPreference().enable(address)
    lastError = null
  } catch (error) {
    await active?.close()
    active = null
    lastError = error instanceof Error ? error.message : String(error)
  }
  publish()
}

export async function disableMobileCompanion(): Promise<void> {
  generation += 1
  savedPreference().disable()
  clearRetry()
  await active?.close()
  active = null
  lastError = null
  publish()
}

export function setMobileDeviceAccess(id: string, access: MobileCompanionAccess): void {
  devices().setAccess(id, access)
  publish()
}

export function revokeMobileDevice(id: string): void {
  devices().revoke(id)
  publish()
}

export async function stopMobileCompanion(): Promise<void> {
  quitting = true
  generation += 1
  clearRetry()
  await active?.close()
  active = null
}
