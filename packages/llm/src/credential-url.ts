// Validation for base URLs that carry a secret credential (an Authorization
// header). Shared between the main-process settings schema (the write path,
// settings:saveExtraProvider) and the shared provider resolver (the read path,
// which sees a tampered or synced settings.json), so both enforce the identical
// rule. Requires https:, except http: is allowed only for loopback hosts;
// rejects embedded userinfo (user:pass@host); and rejects any non-loopback
// private/link-local address so a tampered setting cannot exfiltrate the key to
// an attacker-controlled host nor reach a private or link-local metadata
// endpoint (e.g. https://169.254.169.254) over either scheme.
//
// This module is bundled into the renderer (via extra-providers.ts), so it must
// stay free of node: builtins — the private-address check below is a pure,
// dependency-free classifier rather than node:net's isIP.

export function normalizeHostname(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  // `::ffff:127.0.0.1` reaches the same socket as `127.0.0.1`, so it has to read
  // as loopback here too — otherwise the private-address rule below rejects a
  // local endpoint addressed through its IPv4-mapped form.
  const embedded = embeddedIpv4(host)
  return embedded === '127.0.0.1'
}

function parseIpv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number.parseInt(part, 10) : NaN))
  if (octets.some((n) => Number.isNaN(n) || n > 255)) return null
  const [a, b, c, d] = octets
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null
  return [a, b, c, d]
}

/** The eight 16-bit groups of an IPv6 literal, `::` expanded, or null. */
function parseIpv6Hextets(host: string): number[] | null {
  if (!host.includes(':')) return null
  let text = host
  // A trailing dotted quad (`::ffff:1.2.3.4`) is the low two groups written out.
  // The URL parser rewrites it to hex, but this is also called on raw hostnames.
  const dotted = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(text)
  if (dotted) {
    const octets = parseIpv4Octets(dotted[1] ?? '')
    if (!octets) return null
    const [a, b, c, d] = octets
    text = `${text.slice(0, dotted.index)}:${(((a << 8) | b) >>> 0).toString(16)}:${(((c << 8) | d) >>> 0).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const groupsOf = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null
      out.push(Number.parseInt(piece, 16))
    }
    return out
  }
  const head = groupsOf(halves[0] ?? '')
  if (head === null) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const tail = groupsOf(halves[1] ?? '')
  if (tail === null) return null
  const gap = 8 - head.length - tail.length
  if (gap < 1) return null
  return [...head, ...new Array<number>(gap).fill(0), ...tail]
}

/**
 * Prefixes whose low 32 bits carry an IPv4 address the packet actually reaches:
 * IPv4-mapped and IPv4-translated (RFC 4291 / 2765), the deprecated
 * IPv4-compatible form, and the NAT64 well-known prefix (RFC 6052). Restricted
 * to these — an ordinary global address whose last 32 bits happen to spell a
 * private IPv4 goes nowhere near it.
 */
const IPV4_EMBEDDING_PREFIXES: ReadonlyArray<readonly number[]> = [
  [0, 0, 0, 0, 0, 0xffff], // ::ffff:0:0/96      IPv4-mapped
  [0, 0, 0, 0, 0xffff, 0], // ::ffff:0:0:0/96    IPv4-translated
  [0, 0, 0, 0, 0, 0], // ::/96              IPv4-compatible (deprecated)
  [0x64, 0xff9b, 0, 0, 0, 0], // 64:ff9b::/96       NAT64 well-known
]

/** The IPv4 address an IPv6 literal embeds, in dotted form, or null. */
function embeddedIpv4(host: string): string | null {
  const hextets = parseIpv6Hextets(host)
  if (hextets === null) return null
  const matches = IPV4_EMBEDDING_PREFIXES.some((prefix) =>
    prefix.every((group, index) => hextets[index] === group),
  )
  if (!matches) return null
  const high = hextets[6] ?? 0
  const low = hextets[7] ?? 0
  return `${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`
}

function isPrivateIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a === 169 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

/**
 * True for IPv4/IPv6 literals in a private, loopback, or link-local range (RFC
 * 1918 / 4193 / 3927 / 4291 plus 100.64/10 CGN and 0.0.0.0/8). Hostnames that
 * are not IP literals return false — DNS resolution is not attempted, so this is
 * a defence against literal-address exfiltration, not a full SSRF guard. Mirrors
 * the IP ranges enforced by the fetch_url policy (web-origin-policy.ts).
 */
export function isPrivateOrLinkLocalHost(hostname: string): boolean {
  const host = normalizeHostname(hostname)

  const octets = parseIpv4Octets(host)
  if (octets) return isPrivateIpv4(octets)

  const hextets = parseIpv6Hextets(host)
  if (hextets === null) return false

  // An IPv6 literal that embeds an IPv4 address is classified by that address.
  // Without this, `https://[::ffff:169.254.169.254]/` — the metadata endpoint
  // named above, written in its IPv4-mapped form — read as an ordinary public
  // host, and so did every RFC 1918 range behind the same prefix.
  const embedded = embeddedIpv4(host)
  if (embedded !== null) {
    const inner = parseIpv4Octets(embedded)
    // `::` and `::1` arrive here as 0.0.0.0 and 0.0.0.1, both inside 0.0.0.0/8.
    if (inner && isPrivateIpv4(inner)) return true
  }

  const first = hextets[0] ?? 0
  // fc00::/7 unique local, fe80::/10 link local. The range test replaces a
  // `fe80:` prefix match that missed fe90:: through febf::.
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
}

/**
 * Validate a base URL that will carry a secret credential. Returns the
 * normalized URL string, or throws on invalid input. `label` prefixes the error
 * messages so callers can name the field (e.g. "Remote agent base URL").
 */
export function validateCredentialBaseUrl(value: string, label = 'Base URL'): string {
  const raw = value.trim()
  if (!raw) throw new Error(`${label} cannot be blank`)

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label} is not a valid URL: ${value}`)
  }

  if (url.username || url.password) {
    throw new Error(`${label} must not include embedded credentials`)
  }

  const loopback = isLoopbackHostname(url.hostname)

  if (url.protocol === 'http:') {
    if (loopback) return url.toString()
    throw new Error(`${label} may only use http: for loopback hosts`)
  }

  if (url.protocol !== 'https:') {
    throw new Error(`${label} must use https: ${value}`)
  }

  // https to a non-loopback private/link-local address would carry the key to an
  // internal service (e.g. the cloud metadata endpoint). Loopback stays allowed.
  if (!loopback && isPrivateOrLinkLocalHost(url.hostname)) {
    throw new Error(`${label} must not point at a private or link-local address: ${url.hostname}`)
  }

  return url.toString()
}

/** Boolean form of {@link validateCredentialBaseUrl} for fail-closed read paths. */
export function isSafeCredentialBaseUrl(value: string): boolean {
  try {
    validateCredentialBaseUrl(value)
    return true
  } catch {
    return false
  }
}
