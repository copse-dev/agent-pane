/**
 * Pure policy for automatic remote-artifact image hydration
 * (docs/plans/sandboxed-artifact-image-downloads.md). Nothing here performs I/O,
 * so main, the per-download host and the confined downloader can each apply the
 * same checks independently.
 */
import { BlockList, isIP } from 'node:net'
import {
  REMOTE_ARTIFACT_IMAGE_ERROR_CODES,
  type RemoteArtifactImageErrorCode,
} from '@shared/remote-artifact-image.ts'

export const MAX_ARTIFACT_IMAGE_BYTES = 15 * 1024 * 1024
export const MAX_ARTIFACT_IMAGE_REDIRECTS = 3
export const MAX_ARTIFACT_IMAGE_HEADER_BYTES = 32 * 1024
export const ARTIFACT_IMAGE_DOWNLOAD_DEADLINE_MS = 30_000
/** A body that stops arriving for this long is a stall, not a slow image. */
export const ARTIFACT_IMAGE_IDLE_TIMEOUT_MS = 10_000
export const MAX_ARTIFACT_IMAGE_DIMENSION = 16_384
export const MAX_ARTIFACT_IMAGE_PIXELS = 40_000_000
const MAX_ARTIFACT_PATH_LENGTH = 1024
const MAX_DOWNLOAD_URL_LENGTH = 8192

/**
 * Exact origins Cursor's artifact endpoint hands out signed URLs for.
 *
 * Provenance (recorded in the plan): the bucket host reported for Cursor's
 * `/v1/agents/{id}/artifacts/download` presigned URLs. It has not yet been
 * confirmed against an authenticated fixture; a different real origin fails
 * closed as `origin-denied` naming that origin, never by widening this list.
 */
export const CURSOR_ARTIFACT_DOWNLOAD_ORIGINS: readonly string[] = [
  'https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com',
]

/** Bounded failure codes. These, never raw messages, cross into renderer state and logs. */
export const ARTIFACT_IMAGE_ERROR_CODES = REMOTE_ARTIFACT_IMAGE_ERROR_CODES
export type ArtifactImageErrorCode = RemoteArtifactImageErrorCode

/** Codes a person can usefully retry; policy denials never offer a retry. */
export function isRetryableArtifactImageError(code: ArtifactImageErrorCode): boolean {
  switch (code) {
    case 'metadata-failed':
    case 'http-status':
    case 'timeout':
    case 'network':
    case 'busy':
    case 'protocol':
    case 'cancelled':
      return true
    default:
      return false
  }
}

export class ArtifactImageError extends Error {
  readonly code: ArtifactImageErrorCode
  /** Safe to log: an origin for the two origin codes, a status for `http-status`. */
  readonly detail: string | undefined
  constructor(code: ArtifactImageErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ArtifactImageError'
    this.code = code
    this.detail = detail
  }

  /** The denied origin, for codes whose detail is one. */
  get origin(): string | undefined {
    return this.code === 'origin-denied' || this.code === 'redirect-denied'
      ? this.detail
      : undefined
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Validate a relative `artifacts/` path once, without decoding it.
 *
 * Percent signs are refused outright rather than decoded: a path is used
 * exactly as stored, and refusing `%` removes every ambiguous separator or
 * dot-segment encoding (`%2f`, `%5c`, `%2e%2e`, double encoding) at once.
 */
export function validateArtifactPath(path: string): string {
  if (
    path.length === 0 ||
    path.length > MAX_ARTIFACT_PATH_LENGTH ||
    !path.startsWith('artifacts/') ||
    path.includes('\\') ||
    path.includes('%') ||
    hasControlCharacter(path)
  ) {
    throw new ArtifactImageError('invalid-path')
  }
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ArtifactImageError('invalid-path')
  }
  return path
}

export function supportedImageMimeForPath(path: string): string | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  return null
}

/** Canonicalize one configured origin, or null when it is not an approvable download origin. */
export function canonicalDownloadOrigin(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    isIpLiteralHost(url.hostname) ||
    // Plain DNS labels only: `*` would become an ASRT wildcard allowlist entry.
    !DNS_NAME.test(url.hostname)
  ) {
    return null
  }
  return url.origin
}

/** At least two lowercase LDH labels, no trailing dot, no wildcard. */
const DNS_NAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

function isIpLiteralHost(hostname: string): boolean {
  return isIP(hostname.replace(/^\[(.*)\]$/u, '$1')) !== 0
}

/**
 * RFC 3986 request-target characters. Anything else would be re-encoded by a
 * URL serializer, which can invalidate a signature; refusing it means the
 * target is sent byte-for-byte as the provider wrote it.
 */
const REQUEST_TARGET = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]*$/u

export interface ApprovedDownloadUrl {
  /** The exact string the provider returned, unmodified. */
  href: string
  origin: string
  hostname: string
  /** Path and query, byte-for-byte from `href`. */
  target: string
}

/**
 * Check a download URL against the approved origins. A returned URL never
 * authorizes its own destination: the origin must already be in `approved`.
 */
export function checkDownloadUrl(
  raw: string,
  approved: readonly string[],
  code: 'origin-denied' | 'redirect-denied' = 'origin-denied',
): ApprovedDownloadUrl {
  if (raw.length > MAX_DOWNLOAD_URL_LENGTH) throw new ArtifactImageError(code)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ArtifactImageError(code)
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    raw.includes('#') ||
    isIpLiteralHost(url.hostname)
  ) {
    throw new ArtifactImageError(code)
  }
  const origin = url.origin
  if (!approved.includes(origin)) throw new ArtifactImageError(code, origin)
  // Require the raw text itself to start with the canonical origin, so the
  // target below is a substring of what was received, not a re-serialization.
  if (!raw.startsWith(`${origin}/`)) throw new ArtifactImageError(code, origin)
  const target = raw.slice(origin.length)
  if (!REQUEST_TARGET.test(target)) throw new ArtifactImageError(code, origin)
  return { href: raw, origin, hostname: url.hostname, target }
}

/**
 * Resolve a redirect Location against the current URL and reapply the full
 * policy. Relative locations are resolved; the result must still be exactly an
 * approved origin over HTTPS.
 */
export function resolveRedirect(
  current: ApprovedDownloadUrl,
  location: string,
  approved: readonly string[],
): ApprovedDownloadUrl {
  let next: URL
  try {
    next = new URL(location, current.href)
  } catch {
    throw new ArtifactImageError('redirect-denied')
  }
  // A relative Location is resolved by the URL parser; use its serialization.
  // An absolute one is checked as written so its signed bytes stay intact.
  const absolute = /^[a-z][a-z0-9+.-]*:/iu.test(location)
  return checkDownloadUrl(absolute ? location : next.href, approved, 'redirect-denied')
}

const NON_PUBLIC = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4')
}
// IPv6 is allowlisted to global unicast (2000::/3) below; these carve out the
// special-purpose blocks inside it, plus alternate encodings of IPv4.
for (const [network, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6')
}
const GLOBAL_UNICAST_V6 = new BlockList()
GLOBAL_UNICAST_V6.addSubnet('2000::', 3, 'ipv6')

/**
 * Whether a numeric address is a public, globally routable unicast address.
 * Anything unparseable, mapped (`::ffff:…`), NAT64, ULA, link-local,
 * multicast, loopback or unspecified is not.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !NON_PUBLIC.check(address, 'ipv4')
  if (family === 6) {
    // Zone IDs only exist on link-local/scoped addresses.
    if (address.includes('%')) return false
    return GLOBAL_UNICAST_V6.check(address, 'ipv6') && !NON_PUBLIC.check(address, 'ipv6')
  }
  return false
}
