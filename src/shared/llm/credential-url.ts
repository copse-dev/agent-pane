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
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

function parseIpv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number.parseInt(part, 10) : NaN))
  if (octets.some((n) => Number.isNaN(n) || n > 255)) return null
  return octets as [number, number, number, number]
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
  if (octets) {
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

  if (host.includes(':')) {
    return (
      host === '::' ||
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80:')
    )
  }

  return false
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
