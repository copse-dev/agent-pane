// Hostname allowlist for LLM provider egress (issue #438).
//
// Built-in / loopback hosts are always trusted. A user-added custom provider's
// host must appear in the caller's `approved` list before any network call
// carries an API key or prompt to that host. Pure module — the approved list is
// passed in so this stays free of main-process settings imports.

import {
  isLoopbackHostname,
  isPrivateOrLinkLocalHost,
  normalizeHostname,
} from './credential-url.ts'
import { BUILTIN_EXTRA_PROVIDERS, isLocalBaseUrl } from './extra-providers.ts'
import { OPENROUTER_BASE_URL } from './openrouter.ts'

/** Hardcoded first-party provider hosts (not part of BUILTIN_EXTRA_PROVIDERS). */
const FIRST_PARTY_PROVIDER_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'api.cursor.com',
] as const

/**
 * Reject single-label / mDNS names and private/link-local literals for a
 * non-loopback custom provider host. Mirrors main's web-origin `assertLowRiskHost`
 * without importing `node:net` (this module is renderer-safe).
 */
export function assertLowRiskProviderHost(hostname: string): void {
  const host = normalizeHostname(hostname)
  if (isLoopbackHostname(host)) return
  if (isPrivateOrLinkLocalHost(host)) {
    throw new Error(`Provider host must not be a private or link-local address: ${host}`)
  }
  // IPv4 / IPv6 literals that cleared the private check are fine.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return
  if (!host.includes('.') || host.endsWith('.local')) {
    throw new Error(`Provider host must be a fully-qualified domain name: ${host}`)
  }
}

/** Normalize a provider base URL to its lowercase host key for storage/compare. */
export function providerHostKey(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new Error(`Provider base URL is not a valid URL: ${baseUrl}`)
  }
  return normalizeHostname(url.hostname)
}

/**
 * Hosts that are always allowed — derived from code (built-in presets + first-party
 * providers + OpenRouter). Never user-editable; never prompts.
 */
export function builtinProviderHosts(): Set<string> {
  const hosts = new Set<string>()
  for (const provider of BUILTIN_EXTRA_PROVIDERS) {
    try {
      hosts.add(providerHostKey(provider.baseUrl))
    } catch {
      // A malformed preset URL would already break provider construction.
    }
  }
  try {
    hosts.add(providerHostKey(OPENROUTER_BASE_URL))
  } catch {
    /* ignore */
  }
  for (const host of FIRST_PARTY_PROVIDER_HOSTS) {
    hosts.add(normalizeHostname(host))
  }
  return hosts
}

/**
 * Throws if `baseUrl`'s host is not allowed by (built-ins ∪ local/loopback ∪
 * approved). Call before constructing an SDK client or issuing a credentialed
 * fetch.
 */
export function assertProviderHostAllowed(baseUrl: string, approved: readonly string[]): void {
  const trimmed = baseUrl.trim()
  if (!trimmed) throw new Error('Provider base URL cannot be blank')

  // Local OpenAI-compatible servers (LM Studio, Ollama, …) never need approval.
  if (isLocalBaseUrl(trimmed)) return

  const host = providerHostKey(trimmed)
  if (isLoopbackHostname(host)) return
  if (builtinProviderHosts().has(host)) return

  assertLowRiskProviderHost(host)

  const approvedSet = new Set(approved.map((entry) => normalizeHostname(entry)))
  if (approvedSet.has(host)) return

  throw new Error(`Provider host "${host}" is not approved. Re-add it in Settings → Providers.`)
}

export function isProviderHostAllowed(baseUrl: string, approved: readonly string[]): boolean {
  try {
    assertProviderHostAllowed(baseUrl, approved)
    return true
  } catch {
    return false
  }
}
