/** Mobile Companion's current pairing state, for Settings to render live. */
export interface MobileCompanionStatus {
  enabled: boolean
  /** The LAN origin to pair with, or `null` when not currently serving. */
  url: string | null
  /** An SVG document encoding `url`, or `null` when `url` is `null`. */
  qrSvg: string | null
}
