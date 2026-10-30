import type { ClientAccess } from '../client-auth.ts'

/**
 * Mobile Companion is managed entirely from Settings > Experimental, including
 * pairing approval and the local-root trust acknowledgement for control grants.
 * The main process pushes a fresh snapshot on every change.
 */
export interface MobileCompanionAddress {
  address: string
  interfaceName: string
}

export type MobileCompanionAccess = ClientAccess

export interface MobileCompanionDevice {
  id: string
  label: string
  createdAt: number
  access: MobileCompanionAccess
}

/** A phone is mid-pairing and waiting for this Mac to confirm its code. */
export interface MobileCompanionPairing {
  id: string
  label: string
  code: string
  /**
   * The phone asked over this Mac's publicly trusted name, so its browser
   * verified the connection itself and control needs no local-root step.
   */
  trustedName: boolean
}

/**
 * This Mac's publicly trusted name, `lan.<label>.u.copse.me`, issued by the
 * Copse names service. See docs/remote-access.md.
 */
export interface MobileCompanionPublicName {
  /** The names API this Mac registers with. */
  serviceUrl: string
  /** `unregistered` until an invite is redeemed; then the service's view of the label. */
  state: 'unregistered' | 'active' | 'dormant' | 'retired'
  /** `lan.<label>.u.copse.me`, once registered. */
  hostname: string | null
  certificate: { notAfter: number; renewAt: number | null } | null
  /**
   * What this Mac's own resolver answers for `hostname`: `unresolved` and
   * `mismatch` usually mean a router's DNS-rebind protection drops the answer,
   * and a phone on the same network will not reach the name either.
   */
  dns: 'unknown' | 'checking' | 'ok' | 'unresolved' | 'mismatch'
  busy: 'registering' | 'removing' | null
  lastError: string | null
}

export interface MobileCompanionState {
  enabled: boolean
  running: boolean
  /** The address to open: the trusted name when it is live, otherwise the LAN IP. */
  url: string | null
  /** An SVG document encoding `url`, scanned instead of typed; `null` until generated or when `url` is `null`. */
  qrSvg: string | null
  /**
   * The LAN IP address, when `url` is the trusted name: the fallback for a
   * network whose DNS cannot resolve the name, verified by the local root.
   */
  localUrl: string | null
  /** An SVG document encoding `localUrl`. */
  localQrSvg: string | null
  publicName: MobileCompanionPublicName
  rootCertificatePath: string | null
  addresses: MobileCompanionAddress[]
  devices: MobileCompanionDevice[]
  pairing: MobileCompanionPairing | null
  lastError: string | null
}
