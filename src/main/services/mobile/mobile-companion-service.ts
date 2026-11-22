import { lookup } from 'node:dns/promises'
import { MobilePairing, type PairingVia } from './mobile-pairing.ts'
import QRCode from 'qrcode'
import { getSecretCipher } from '@copse/store-kit/secret-cipher.ts'
import type {
  MobileCompanionAccess,
  MobileCompanionState,
} from '../../../shared/types/mobile-companion.ts'
import { broadcastToAppWindows } from '../../windows/app-window-broadcast.ts'
import { MobileDevices } from './mobile-devices.ts'
import { MobilePreference } from './mobile-preference.ts'
import { mobileLanAddresses, startMobileServer, type MobileServer } from './mobile-server.ts'
import { readDefaultRouteInterface } from './default-route.ts'
import { DEFAULT_NAMES_API, NamesClient } from '../remote-names/names-client.ts'
import { RemoteNames } from '../remote-names/names-service.ts'
import { NamesStore } from '../remote-names/names-store.ts'
import { errorMessage } from '@shared/errors.ts'
import { nonEmptyStringOr } from '@copse/std/unknown-value.ts'
import { toBase64Url, utf8 } from '@copse/remote-protocol/encoding.ts'
import { COPSE_SHELL_ORIGIN } from '../../../shared/mobile-asset-routes.ts'
import type {
  MobileCompanionRelay,
  MobileCompanionShellPairing,
} from '../../../shared/types/mobile-companion.ts'
import {
  DEFAULT_RELAY,
  parseRelayEndpoint,
  RelayTunnel,
  type RelayEndpoint,
} from '../remote-names/relay-tunnel.ts'

let active: MobileServer | null = null
let preference: MobilePreference | null = null
let deviceStore: MobileDevices | null = null
let starting: Promise<MobileServer> | null = null
let retry: ReturnType<typeof setTimeout> | null = null
let quitting = false
let generation = 0
let lastError: string | null = null
const qrCache = new Map<string, string>()
const pairingRequests = new MobilePairing()
const RETRY_MS = 15_000
let names: RemoteNames | null = null
let store: NamesStore | null = null
let relayEnabled: boolean | null = null
let relayTunnel: { label: string; tunnel: RelayTunnel } | null = null
let shellPairing: { url: string; expiresAt: number; timer: ReturnType<typeof setTimeout> } | null =
  null
let defaultInterface: string | null = null
let defaultInterfaceCheckedAt = 0
const DEFAULT_ROUTE_REFRESH_MS = 10_000

/**
 * Re-read which interface carries the default route, at most every ten
 * seconds, and republish when it changes so Settings re-sorts its list.
 */
function refreshDefaultInterface(): Promise<void> {
  if (Date.now() - defaultInterfaceCheckedAt < DEFAULT_ROUTE_REFRESH_MS) return Promise.resolve()
  defaultInterfaceCheckedAt = Date.now()
  return readDefaultRouteInterface().then((next) => {
    if (next === defaultInterface) return
    defaultInterface = next
    publish()
  })
}

function lanAddresses(): ReturnType<typeof mobileLanAddresses> {
  return mobileLanAddresses(undefined, defaultInterface)
}
let namesStarted = false

/**
 * The names API for a new registration. `COPSE_NAMES_API_URL` points a Mac at
 * another deployment of the service (staging, or a self-hosted one); it is not
 * a `config.json` setting because a renderer-writable URL could send signed
 * requests, replayable for five minutes, somewhere else.
 */
function namesServiceUrl(): string {
  const configured = process.env['COPSE_NAMES_API_URL']?.trim()
  if (configured) return configured
  return DEFAULT_NAMES_API
}

/**
 * The relay this Mac holds its tunnel to. `COPSE_RELAY` (`host[:port]`) points
 * a Mac at another deployment, like `COPSE_NAMES_API_URL`, and is likewise not
 * a renderer-writable setting. A wrong relay cannot read relayed traffic (the
 * browser's TLS ends on this Mac), but it could hold the tunnel open and drop it.
 */
function relayEndpoint(): RelayEndpoint | null {
  return parseRelayEndpoint(nonEmptyStringOr(process.env['COPSE_RELAY']?.trim(), DEFAULT_RELAY))
}

function namesStore(): NamesStore {
  store ??= new NamesStore(getSecretCipher)
  return store
}

function relayChosen(): boolean {
  relayEnabled ??= namesStore().readRelayEnabled()
  return relayEnabled
}

function remoteNames(): RemoteNames {
  names ??= new RemoteNames({
    store: namesStore(),
    client: (baseUrl, key): NamesClient => new NamesClient({ baseUrl, key }),
    serviceUrl: namesServiceUrl,
    lookup: async (hostname): Promise<string[]> => {
      try {
        return (await lookup(hostname, { all: true, family: 4 })).map((entry) => entry.address)
      } catch {
        return []
      }
    },
    onChange: publish,
  })
  return names
}

function savedPreference(): MobilePreference {
  preference ??= new MobilePreference()
  return preference
}

function devices(): MobileDevices {
  deviceStore ??= new MobileDevices()
  return deviceStore
}

function publish(): void {
  syncRelay()
  broadcastToAppWindows('mobile:state-changed', getMobileCompanionState())
}

/**
 * Hold the relay tunnel exactly while the user chose it, Mobile Companion is
 * serving and the name is active with a valid certificate. Every state change
 * re-runs this; it is idempotent.
 */
function syncRelay(): void {
  const target =
    !quitting && relayChosen() && active?.isRunning() ? remoteNames().relayTarget() : null
  const endpoint = target ? relayEndpoint() : null
  if (relayTunnel && (!target || !endpoint || relayTunnel.label !== target.label)) {
    relayTunnel.tunnel.stop()
    relayTunnel = null
  }
  if (!target || !endpoint || relayTunnel) return
  const tunnel = new RelayTunnel({
    endpoint,
    label: target.label,
    sign: (text): Promise<string> => remoteNames().signTunnel(text),
    onStream: (stream, clientIp): void => {
      if (active?.isRunning()) active.acceptRelayed(stream, clientIp)
      else stream.destroy()
    },
    onStatus: (): void => {
      broadcastToAppWindows('mobile:state-changed', getMobileCompanionState())
    },
  })
  relayTunnel = { label: target.label, tunnel }
  tunnel.start()
}

function relayState(): MobileCompanionRelay {
  const endpoint = relayEndpoint()
  const enabled = relayChosen()
  const hostname = remoteNames().webHostname()
  const base = {
    enabled,
    relay: endpoint
      ? `${endpoint.host}${endpoint.port === 443 ? '' : `:${String(endpoint.port)}`}`
      : '',
    hostname,
    error: null,
    retryAt: null,
  }
  if (!enabled) return { ...base, status: 'off' }
  if (!endpoint)
    return {
      ...base,
      status: 'waiting',
      error: 'COPSE_RELAY is not a host name with an optional port.',
    }
  const tunnel = relayTunnel?.tunnel.status()
  if (!tunnel || tunnel.state === 'stopped') return { ...base, status: 'waiting' }
  return { ...base, status: tunnel.state, error: tunnel.error, retryAt: tunnel.retryAt }
}

function currentShellPairing(): MobileCompanionShellPairing | null {
  if (!shellPairing) return null
  return {
    url: shellPairing.url,
    qrSvg: currentQrSvg(shellPairing.url),
    expiresAt: shellPairing.expiresAt,
  }
}

function clearShellPairing(): void {
  if (shellPairing) clearTimeout(shellPairing.timer)
  shellPairing = null
}

/**
 * The QR is a convenience, not a trust proof — it carries no claim about
 * bundle integrity, it just saves typing `url` into the phone's browser. It
 * is generated lazily and cached per URL; a cache miss republishes state once
 * generation finishes instead of blocking this synchronous read.
 */
function currentQrSvg(url: string | null): string | null {
  if (!url) return null
  const cached = qrCache.get(url)
  if (cached !== undefined) return cached
  void QRCode.toString(url, { type: 'svg', margin: 1 })
    .then((svg) => {
      // At most the trusted-name, LAN-IP and copse.me pairing codes are live at once.
      if (qrCache.size >= 6) qrCache.clear()
      qrCache.set(url, svg)
      publish()
    })
    .catch((error: unknown) => {
      console.error('[mobile] could not generate the pairing QR:', error)
    })
  return null
}

export function getMobileCompanionState(): MobileCompanionState {
  void refreshDefaultInterface()
  const running = active?.isRunning() ?? false
  const ipUrl = running ? (active?.url ?? null) : null
  const name = running ? remoteNames().identity()?.hostname : undefined
  const url = name && active ? `https://${name}:${String(active.port)}` : ipUrl
  const localUrl = url === ipUrl ? null : ipUrl
  return {
    enabled: savedPreference().current().enabled,
    running,
    url,
    qrSvg: currentQrSvg(url),
    localUrl,
    localQrSvg: currentQrSvg(localUrl),
    publicName: remoteNames().state(),
    relay: relayState(),
    shellPairing: currentShellPairing(),
    rootCertificatePath: running ? (active?.rootPath ?? null) : null,
    address: running ? (active?.address ?? null) : null,
    addresses: lanAddresses(),
    devices: devices().list(),
    pairing: pairingRequests.current(),
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
function approvePair(
  label: string,
  code: string,
  signal: AbortSignal,
  via: PairingVia,
): Promise<MobileCompanionAccess | null> {
  const result = pairingRequests.request(label, code, signal, via)
  publish()
  return result.finally(publish)
}

export function respondToMobilePairing(
  decision: MobileCompanionAccess | 'deny',
  code: string,
  id: string,
  rootTrusted = false,
): void {
  if (quitting) return
  if (pairingRequests.respond(decision, code, id, rootTrusted)) publish()
}

function launch(address: string): Promise<MobileServer> {
  if (starting) return starting
  const startedGeneration = generation
  starting = startMobileServer({
    address,
    devices: devices(),
    approvePair,
    publicIdentity: () => remoteNames().identity(),
    onDevicesChanged: publish,
    onStop: () => {
      active = null
      remoteNames().setServerAddress(null)
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
      remoteNames().setServerAddress(server.address)
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
  // Renewal runs whether or not the companion is on: a name nobody renews for
  // 30 days goes dormant. Retries re-enter here; the names service starts once.
  if (!namesStarted) {
    namesStarted = true
    void remoteNames().start()
  }
  try {
    const choice = savedPreference().current()
    if (!choice.enabled || active?.isRunning()) return
    await refreshDefaultInterface()
    const addresses = lanAddresses()
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
    lastError = errorMessage(error)
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
    lastError = errorMessage(error)
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
  const device = devices()
    .list()
    .find((item) => item.id === id)
  // This synchronous path cannot interleave a grant with device revocation.
  if (!device || quitting) return
  devices().setAccess(id, access)
  publish()
}

export function revokeMobileDevice(id: string): void {
  devices().revoke(id)
  publish()
}

/** Redeem an invite for this Mac's trusted name; progress and errors arrive as state. */
export async function registerMobilePublicName(invite: string): Promise<void> {
  if (quitting) return
  await remoteNames().register(invite)
}

/** Delete this Mac's name from the names service and forget its key. */
export async function removeMobilePublicName(): Promise<void> {
  if (quitting) return
  await remoteNames().remove()
  // The store forgot the relay choice with the name; a new name starts with it off.
  relayEnabled = null
  clearShellPairing()
  publish()
}

export async function recheckMobilePublicNameDns(): Promise<void> {
  if (quitting) return
  await remoteNames().recheckDns()
}

/** Choose whether phones paired at copse.me reach this Mac through the Copse relay. */
export function setMobileRelayEnabled(enabled: boolean): void {
  if (quitting) return
  namesStore().writeRelayEnabled(enabled)
  relayEnabled = enabled
  if (!enabled) clearShellPairing()
  publish()
}

/**
 * Show a one-time code that adds this Mac to a copse.me account. The grant is
 * signed by the device key and redeemed once by the names API; it travels in
 * the URL fragment so it never reaches a server log.
 */
export async function createMobileShellPairing(): Promise<void> {
  if (quitting) return
  const grant = await remoteNames().shellGrant()
  clearShellPairing()
  const url = `${COPSE_SHELL_ORIGIN}/add#g=${toBase64Url(utf8(JSON.stringify(grant)))}`
  const timer = setTimeout(
    () => {
      if (shellPairing?.url !== url) return
      shellPairing = null
      publish()
    },
    Math.max(0, grant.expiresMs - Date.now()),
  )
  timer.unref()
  shellPairing = { url, expiresAt: grant.expiresMs, timer }
  publish()
}

export function clearMobileShellPairing(): void {
  clearShellPairing()
  publish()
}

export async function stopMobileCompanion(): Promise<void> {
  quitting = true
  generation += 1
  clearRetry()
  clearShellPairing()
  relayTunnel?.tunnel.stop()
  relayTunnel = null
  names?.stop()
  await active?.close()
  active = null
}
