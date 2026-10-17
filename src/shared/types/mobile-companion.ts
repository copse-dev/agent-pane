/**
 * Mobile Companion is managed entirely from Settings > Experimental, including
 * pairing approval and the local-root trust acknowledgement for control grants.
 * The main process pushes a fresh snapshot on every change.
 */
export interface MobileCompanionAddress {
  address: string
  interfaceName: string
}

export type MobileCompanionAccess = 'read' | 'control'

export interface MobileCompanionDevice {
  id: string
  label: string
  createdAt: number
  access: MobileCompanionAccess
}

/** A phone is mid-pairing and waiting for this Mac to confirm its code. */
export interface MobileCompanionPairing {
  label: string
  code: string
}

export interface MobileCompanionState {
  enabled: boolean
  running: boolean
  url: string | null
  /** An SVG document encoding `url`, scanned instead of typed; `null` until generated or when `url` is `null`. */
  qrSvg: string | null
  rootCertificatePath: string | null
  addresses: MobileCompanionAddress[]
  devices: MobileCompanionDevice[]
  pairing: MobileCompanionPairing | null
  lastError: string | null
}
