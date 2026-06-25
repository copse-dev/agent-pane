/**
 * Pure navigation policy for the built-in browser tools. Mirrors the shell/MCP
 * permission split: loopback (localhost) targets auto-run, public origins prompt
 * once, and private / link-local / metadata targets are denied outright to block
 * SSRF-style pivots from an agent-controlled URL.
 *
 * Kept free of Electron imports so it runs under the bundled unit-test runner.
 */

export const BROWSER_TOOLS = new Set([
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_tabs',
])

/** Browser tools that never leave the current page and so never need an origin prompt. */
export const READ_ONLY_BROWSER_TOOLS = new Set([
  'browser_snapshot',
  'browser_screenshot',
  'browser_tabs',
])

export const BROWSER_TOOLS_ENABLED_SETTING = 'browserToolsEnabled'

/** Whether the user may be prompted to approve a new public browser origin. */
export const BROWSER_ALLOW_USER_APPROVAL_SETTING = 'browserAllowUserApproval'

export interface ParsedBrowserUrl {
  protocol: string
  hostname: string
  port: string
  /** Normalized `scheme://host:port` key used for allow/remember comparisons. */
  origin: string
}

const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
}

/** Parse and normalize an http/https URL; returns null for anything else. */
export function parseBrowserUrl(raw: string): ParsedBrowserUrl | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const hostname = url.hostname.toLowerCase()
  if (!hostname) return null
  const port = url.port || (DEFAULT_PORTS[url.protocol] ?? '')
  return { protocol: url.protocol, hostname, port, origin: `${url.protocol}//${hostname}:${port}` }
}

/**
 * Scheme allowlist for the in-app browser guest's own navigations (`will-navigate`
 * / `will-redirect`). The guest may browse the public web freely, but must never be
 * driven to local or privileged schemes (`file:`, `chrome:`, `data:`, …) by a
 * hostile page or redirect, which would render local files inside the guest.
 */
export function isAllowedBrowserNavigationUrl(url: string): boolean {
  if (url === 'about:blank') return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/** Loopback targets (localhost dev servers) — the primary supported workflow. */
export function isLoopbackHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname)
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  // 127.0.0.0/8
  const v4 = parseIpv4(host)
  if (v4 && v4[0] === 127) return true
  return false
}

/**
 * Private, link-local, and cloud-metadata targets. Denied so an agent cannot use
 * the headless browser to reach internal services the user never intended to expose.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname)
  // Unspecified address routes to loopback on most stacks.
  if (host === '0.0.0.0' || host === '::') return true
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host === '::')
    return true
  const v4 = parseIpv4(host)
  if (!v4) return false
  const [a, b] = v4
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return false // loopback handled separately (allowed)
  if (a === 172 && b! >= 16 && b! <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 169 && b === 254) return true // link-local incl. 169.254.169.254 metadata
  if (a === 100 && b! >= 64 && b! <= 127) return true // 100.64.0.0/10 carrier-grade NAT
  return false
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null
  return nums as [number, number, number, number]
}

export type BrowserNavDecision =
  | { action: 'allow'; origin: string; reasons: string[] }
  | { action: 'prompt'; origin: string; reasons: string[] }
  | { action: 'deny'; origin: string | null; reasons: string[] }

export interface BrowserNavInput {
  url: string
  /** Origins the user previously approved (normalized scheme://host:port). */
  allowedOrigins: readonly string[]
  /** Whether interactive approval is permitted for new public origins. */
  allowUserApproval: boolean
}

/** Decide whether navigating the built-in browser to `url` is allowed. */
export function decideBrowserNavigation(input: BrowserNavInput): BrowserNavDecision {
  const parsed = parseBrowserUrl(input.url)
  if (!parsed) {
    return { action: 'deny', origin: null, reasons: ['only http/https URLs are supported'] }
  }
  const { hostname, origin } = parsed

  if (isBlockedHost(hostname)) {
    return {
      action: 'deny',
      origin,
      reasons: [`${hostname} is a private/link-local address and cannot be reached`],
    }
  }
  if (isLoopbackHost(hostname)) {
    return { action: 'allow', origin, reasons: ['loopback (localhost) target'] }
  }
  if (input.allowedOrigins.includes(origin)) {
    return { action: 'allow', origin, reasons: ['origin previously allowed'] }
  }
  if (!input.allowUserApproval) {
    return {
      action: 'deny',
      origin,
      reasons: ['new web origin and interactive approval is disabled'],
    }
  }
  return { action: 'prompt', origin, reasons: ['new public web origin requires approval'] }
}

export function formatBrowserPromptBody(origin: string, url: string): string {
  return `The agent wants to open a browser page at:\n\n${url}\n\nOrigin: ${origin}`
}
