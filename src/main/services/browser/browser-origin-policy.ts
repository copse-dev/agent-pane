/**
 * Pure navigation policy for the built-in browser tools. Mirrors the shell/MCP
 * permission split: loopback (localhost) targets auto-run, public origins prompt
 * once, and private / link-local / metadata targets are denied outright to block
 * SSRF-style pivots from an agent-controlled URL.
 *
 * Kept free of Electron imports so it runs under the bundled unit-test runner.
 *
 * Address parsing is shared with the credential-URL and fetch_url rules
 * (`credential-url.ts`); only the range table below is the browser's own, since
 * loopback is allowed here rather than blocked.
 */
import { embeddedIpv4, parseIpv6Hextets } from '@copse/llm/credential-url.ts'

export const BROWSER_TOOLS = new Set([
  'browser_preview',
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_tabs',
  'browser_show',
])

/** Browser tools that never leave the current page and so never need an origin prompt. */
export const READ_ONLY_BROWSER_TOOLS = new Set([
  'browser_snapshot',
  'browser_screenshot',
  'browser_tabs',
  // Promotes a canvas artefact, or a page already open in this session, into the
  // visible pane. It cannot reach a new origin (the tool rejects a URL that is
  // not already open), so there is nothing for an origin prompt to decide.
  'browser_show',
])

export const BROWSER_TOOLS_ENABLED_SETTING = 'browserToolsEnabled'

/** Whether the user may be prompted to approve a new public browser origin. */
export const BROWSER_ALLOW_USER_APPROVAL_SETTING = 'browserAllowUserApproval'

// On by default: the built-in browser (Electron's bundled Chromium) is how the
// agent loads and screenshots local web UIs without downloading a separate
// browser stack (e.g. Playwright). Navigation is still gated by the origin
// policy below — loopback auto-runs, public origins prompt, private is denied.
export const BROWSER_TOOLS_DEFAULT_ENABLED = true

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

/**
 * The IPv4 address `host` denotes, written plainly or carried inside an IPv6
 * literal. `[::ffff:169.254.169.254]` reaches the same host as
 * `169.254.169.254`, so it has to be classified the same way.
 */
function ipv4For(host: string): [number, number, number, number] | null {
  return parseIpv4(host) ?? parseIpv4(embeddedIpv4(host) ?? '')
}

/** Loopback targets (localhost dev servers) — the primary supported workflow. */
export function isLoopbackHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname)
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const hextets = parseIpv6Hextets(host)
  // ::1 in any spelling, including the fully written-out form.
  if (hextets && hextets.every((group, index) => group === (index === 7 ? 1 : 0))) return true
  const v4 = ipv4For(host)
  return v4 !== null && v4[0] === 127 // 127.0.0.0/8
}

/**
 * Private, link-local, and cloud-metadata targets. Denied so an agent cannot use
 * the headless browser to reach internal services the user never intended to expose.
 *
 * Ranges are decided on the parsed address, never on the hostname text. A
 * `startsWith('fc')` test also matches every name that happens to begin those
 * letters (fda.gov, fcc.gov, fdroid.org), a `'fe8'` test covers only a quarter
 * of fe80::/10 — which runs to febf — and neither sees an IPv4 address written
 * inside an IPv6 literal.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname)
  // Unspecified address routes to loopback on most stacks.
  if (host === '0.0.0.0') return true
  const v4 = ipv4For(host)
  if (v4) {
    const [a, b] = v4
    if (v4.every((octet) => octet === 0)) return true
    if (a === 10) return true // 10.0.0.0/8
    if (a === 127) return false // loopback handled separately (allowed)
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true // 192.168.0.0/16
    if (a === 169 && b === 254) return true // link-local incl. 169.254.169.254 metadata
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 carrier-grade NAT
    return false
  }
  const hextets = parseIpv6Hextets(host)
  // Not an IP literal at all: a hostname. DNS is deliberately not resolved here.
  if (!hextets) return false
  if (hextets.every((group) => group === 0)) return true // ::
  const first = hextets[0] ?? 0
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  return false
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null
  const [a, b, c, d] = nums
  return a === undefined || b === undefined || c === undefined || d === undefined
    ? null
    : [a, b, c, d]
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
