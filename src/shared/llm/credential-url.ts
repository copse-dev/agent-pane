// Validation for base URLs that carry a secret credential (an Authorization
// header). Shared between the main-process settings schema (the write path,
// settings:saveExtraProvider) and the shared provider resolver (the read path,
// which sees a tampered or synced settings.json), so both enforce the identical
// rule. Requires https:, except http: is allowed only for loopback hosts, and
// rejects embedded userinfo (user:pass@host) so a tampered setting cannot
// exfiltrate the key to an attacker-controlled host, nor reach a private/
// link-local metadata endpoint over cleartext http.

export function normalizeHostname(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
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

  if (url.protocol === 'https:') return url.toString()

  if (url.protocol === 'http:') {
    if (isLoopbackHostname(url.hostname)) return url.toString()
    throw new Error(`${label} may only use http: for loopback hosts`)
  }

  throw new Error(`${label} must use https: ${value}`)
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
