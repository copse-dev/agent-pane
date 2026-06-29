import { isIP } from 'node:net'
import { DEFAULT_WEB_ALLOWED_ORIGINS } from '@shared/web-origins.ts'

export {
  DEFAULT_WEB_ALLOWED_ORIGINS,
  WEB_ALLOWED_ORIGINS_SETTING,
  WEB_ALLOW_USER_APPROVAL_SETTING,
} from '@shared/web-origins.ts'

const MAX_REDIRECTS = 5
const WEB_FETCH_TIMEOUT_MS = 30_000
const MAX_WEB_FETCH_BYTES = 2 * 1024 * 1024

interface OriginPattern {
  protocol: 'http:' | 'https:' | null
  hostname: string
  port: string | null
}

const temporaryAllowedOrigins = new Set<string>()

function normalizeHostname(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function normalizePort(url: URL): string {
  if (url.port) return url.port
  return url.protocol === 'http:' ? '80' : '443'
}

export function webOriginKey(url: URL): string {
  const hostname = normalizeHostname(url.hostname)
  const host = hostname.includes(':') ? `[${hostname}]` : hostname
  return `${url.protocol}//${host}:${normalizePort(url)}`
}

function parseOriginPattern(input: string): OriginPattern {
  const raw = input.trim().toLowerCase()
  if (!raw) throw new Error('Web origin entries cannot be blank')

  const wildcardPort = raw.endsWith(':*')
  const withoutWildcardPort = wildcardPort ? `${raw.slice(0, -2)}:1` : raw
  const wildcardHost = withoutWildcardPort.includes('://*.') || withoutWildcardPort.startsWith('*.')
  const parseable = wildcardHost
    ? withoutWildcardPort.replace('://*.', '://wildcard.').replace(/^\*\./, 'wildcard.')
    : withoutWildcardPort
  const hasScheme = /^https?:\/\//.test(raw)
  const parsed = hasScheme ? new URL(parseable) : new URL(`https://${parseable}`)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Web origin must use http or https: ${input}`)
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Web origin must not include credentials, path, query, or fragment: ${input}`)
  }

  let hostname = normalizeHostname(parsed.hostname)
  if (wildcardHost) {
    if (!hostname.startsWith('wildcard.')) throw new Error(`Invalid wildcard origin: ${input}`)
    hostname = `*.${hostname.slice('wildcard.'.length)}`
  }
  if (!hostname) throw new Error(`Web origin must include a host: ${input}`)

  if (hostname.startsWith('*.')) {
    const suffix = hostname.slice(2)
    if (!suffix || suffix.includes('*')) throw new Error(`Invalid wildcard origin: ${input}`)
  } else if (hostname.includes('*')) {
    throw new Error(`Wildcard origins must start with "*." only: ${input}`)
  }

  return {
    protocol: hasScheme ? (parsed.protocol) : null,
    hostname,
    port: wildcardPort ? '*' : parsed.port || null,
  }
}

export function validateWebOriginPattern(input: string): string {
  parseOriginPattern(input)
  return input.trim().toLowerCase()
}

export function normalizeWebAllowedOrigins(input: readonly string[]): string[] {
  return [...new Set(input.map(validateWebOriginPattern))]
}

export function sandboxAllowedDomainsFromOrigins(input: readonly string[]): string[] {
  const domains = input.map((entry) => parseOriginPattern(entry).hostname)
  return [...new Set(domains)]
}

export function parseFetchUrl(input: string): URL {
  const url = new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`fetch_url only supports HTTP/HTTPS URLs: ${input}`)
  }
  assertLowRiskHost(url.hostname)
  return url
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/**
 * Validate a base URL that will carry a secret credential (e.g. the Cursor API
 * key Authorization header). Requires https:, except http: is allowed only for
 * loopback hosts. Embedded userinfo (user:pass@host) is rejected so a tampered
 * or synced setting cannot exfiltrate the key to an attacker-controlled host.
 * Returns the normalized URL string, or throws on invalid input.
 */
export function validateRemoteAgentBaseUrl(value: string): string {
  const raw = value.trim()
  if (!raw) throw new Error('Remote agent base URL cannot be blank')

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Remote agent base URL is not a valid URL: ${value}`)
  }

  if (url.username || url.password) {
    throw new Error('Remote agent base URL must not include embedded credentials')
  }

  if (url.protocol === 'https:') return url.toString()

  if (url.protocol === 'http:') {
    if (isLoopbackHostname(url.hostname)) return url.toString()
    throw new Error('Remote agent base URL may only use http: for loopback hosts')
  }

  throw new Error(`Remote agent base URL must use https: ${value}`)
}

function assertLowRiskHost(hostname: string): void {
  const host = normalizeHostname(hostname)
  if (isLoopbackHostname(host)) return

  const ipVersion = isIP(host)
  if (ipVersion === 4) {
    const [a = 0, b = 0] = host.split('.').map((part) => Number.parseInt(part, 10))
    const privateOrSpecial =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a === 169 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    if (privateOrSpecial) throw new Error(`fetch_url blocks private or link-local IPs: ${host}`)
    return
  }

  if (ipVersion === 6) {
    const compact = host.toLowerCase()
    if (
      compact === '::' ||
      compact === '::1' ||
      compact.startsWith('fc') ||
      compact.startsWith('fd') ||
      compact.startsWith('fe80:')
    ) {
      throw new Error(`fetch_url blocks private or link-local IPs: ${host}`)
    }
    return
  }

  // Single-label and mDNS names commonly resolve on local networks.
  if (!host.includes('.') || host.endsWith('.local')) {
    throw new Error(`fetch_url blocks local network hostnames: ${host}`)
  }
}

function hostnameMatches(pattern: string, hostname: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1)
    return hostname.endsWith(suffix) && hostname.length > suffix.length
  }
  return hostname === pattern
}

export function isWebOriginAllowed(url: URL, allowedOrigins: readonly string[]): boolean {
  const hostname = normalizeHostname(url.hostname)
  const urlPort = normalizePort(url)
  const originKey = webOriginKey(url)
  if (temporaryAllowedOrigins.has(originKey)) return true

  return allowedOrigins.some((entry) => {
    const pattern = parseOriginPattern(entry)
    if (pattern.protocol && pattern.protocol !== url.protocol) return false
    if (pattern.port && pattern.port !== '*' && pattern.port !== urlPort) return false
    return hostnameMatches(pattern.hostname, hostname)
  })
}

export function assertWebOriginAllowed(url: URL, allowedOrigins: readonly string[]): void {
  if (!isWebOriginAllowed(url, allowedOrigins)) {
    throw new Error(`Web origin is not allowed: ${webOriginKey(url)}`)
  }
}

export function grantWebOriginForNextFetch(origin: string): void {
  temporaryAllowedOrigins.add(origin)
}

export function clearWebOriginGrant(origin: string): void {
  temporaryAllowedOrigins.delete(origin)
}

export function webAllowedOriginsWithDefaults(
  saved: readonly string[] | null | undefined,
): string[] {
  return normalizeWebAllowedOrigins(saved?.length ? saved : DEFAULT_WEB_ALLOWED_ORIGINS)
}

export async function fetchWithWebOriginPolicy(
  initialUrl: URL,
  init: RequestInit,
  allowedOrigins: readonly string[],
): Promise<Response> {
  let url = initialUrl
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    assertLowRiskHost(url.hostname)
    assertWebOriginAllowed(url, allowedOrigins)
    const timeout = AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    const res = await fetch(url, { ...init, signal, redirect: 'manual' })
    if (res.status < 300 || res.status >= 400) return res
    const location = res.headers.get('location')
    if (!location) return res
    url = new URL(location, url)
  }
  throw new Error(`Fetch exceeded ${MAX_REDIRECTS} redirects: ${initialUrl.toString()}`)
}

export async function readWebResponseText(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return res.text()

  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    received += value.byteLength
    if (received > MAX_WEB_FETCH_BYTES) {
      await reader.cancel()
      throw new Error(`Fetch response exceeded ${MAX_WEB_FETCH_BYTES} bytes`)
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
