import type { ClientAccess } from '../client-auth.ts'

/**
 * Mobile Companion is managed entirely from Settings > Experimental, including
 * pairing approval and the local-root trust acknowledgement for control grants.
 * The main process pushes a fresh snapshot on every change.
 */
export interface MobileCompanionAddress {
  address: string
  interfaceName: string
  /** A VM bridge or VPN tunnel, which a phone on the local network almost never reaches. */
  virtual: boolean
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
  /**
   * The phone reached this Mac through the Copse relay. That says nothing about
   * where the phone is: the copse.me shell also falls back to the relay on the
   * Mac's own network. Absent from a Mac that predates the relay.
   */
  relayed?: boolean
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

/**
 * Reaching this Mac from outside its network: `web.<label>.u.copse.me`
 * through the Copse relay, with phones paired at copse.me. The relay passes
 * the encrypted connection through; this Mac completes TLS itself. See
 * docs/remote-access.md.
 */
export interface MobileCompanionRelay {
  /** The user chose to be reachable through the relay. Off until they turn it on. */
  enabled: boolean
  /**
   * `off` when not chosen; `waiting` when chosen but not possible yet (Mobile
   * Companion is off, or the name is not active with a valid certificate);
   * otherwise the tunnel's own state.
   */
  status: 'off' | 'waiting' | 'connecting' | 'connected' | 'retrying'
  /** The relay this Mac connects to (`COPSE_RELAY`, normally `relay.copse.dev`). */
  relay: string
  /** `web.<label>.u.copse.me`, once registered. */
  hostname: string | null
  /** Why the last attempt ended, while retrying. */
  error: string | null
  retryAt: number | null
}

/** A one-time code that adds this Mac to one copse.me account, shown as a QR. */
export interface MobileCompanionShellPairing {
  /** `https://copse.me/add#g=…`; the grant stays in the fragment, out of server logs. */
  url: string
  /** An SVG document encoding `url`; `null` until generated. */
  qrSvg: string | null
  expiresAt: number
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
  /** Absent from a Mac that predates the relay. */
  relay?: MobileCompanionRelay
  shellPairing?: MobileCompanionShellPairing | null
  rootCertificatePath: string | null
  /** The address the running server is bound to. */
  address: string | null
  /** Best first: the default-route interface, then physical, then virtual. */
  addresses: MobileCompanionAddress[]
  devices: MobileCompanionDevice[]
  pairing: MobileCompanionPairing | null
  lastError: string | null
}
