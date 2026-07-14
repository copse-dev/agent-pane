// Persistence + save-time approval for custom provider hosts (issue #438).

import {
  assertProviderHostAllowed,
  isProviderHostAllowed,
  providerHostKey,
} from '@copse/llm/provider-host-policy.ts'
import {
  BUILTIN_EXTRA_PROVIDER_SLUGS,
  type StoredExtraProvider,
} from '@copse/llm/extra-providers.ts'
import { normalizeHostname } from '@copse/llm/credential-url.ts'
import {
  APPROVED_PROVIDER_HOSTS_SETTING,
  PROVIDER_ALLOW_USER_APPROVAL_SETTING,
} from '../../../shared/provider-hosts.ts'
import { requestApproval } from '../approval.ts'
import { getSetting, setSetting } from '../storage/settings.ts'

function normalizeApprovedHosts(hosts: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of hosts) {
    const host = normalizeHostname(raw)
    if (!host || seen.has(host)) continue
    seen.add(host)
    out.push(host)
  }
  return out
}

/** Hosts already implied by persisted custom (non-builtin) providers. */
function hostsFromStoredCustoms(): string[] {
  const stored = getSetting<StoredExtraProvider[]>('extraProviders', [])
  if (!Array.isArray(stored)) return []
  const hosts: string[] = []
  for (const record of stored) {
    if (BUILTIN_EXTRA_PROVIDER_SLUGS.includes(record.slug)) continue
    const baseUrl = record.baseUrl?.trim()
    if (!baseUrl) continue
    try {
      hosts.push(providerHostKey(baseUrl))
    } catch {
      /* skip malformed */
    }
  }
  return hosts
}

/**
 * Current approved custom-provider hosts (lowercase).
 *
 * When the setting has never been written, hosts of already-stored custom
 * providers are treated as approved so an upgrade does not break existing
 * configurations (issue #438). Call {@link migrateApprovedProviderHosts} once
 * at startup to persist that grandfathered list.
 */
export function getApprovedProviderHosts(): string[] {
  const saved = getSetting<string[] | null>(APPROVED_PROVIDER_HOSTS_SETTING, null)
  if (saved !== null) {
    return normalizeApprovedHosts(saved)
  }
  return normalizeApprovedHosts(hostsFromStoredCustoms())
}

/**
 * Persist the grandfathered allowlist when the setting has never been written.
 * Idempotent — safe to call on every app start.
 */
export async function migrateApprovedProviderHosts(): Promise<void> {
  const saved = getSetting<string[] | null>(APPROVED_PROVIDER_HOSTS_SETTING, null)
  if (saved !== null) return
  await setApprovedProviderHosts(hostsFromStoredCustoms())
}

export async function setApprovedProviderHosts(hosts: readonly string[]): Promise<string[]> {
  const normalized = normalizeApprovedHosts(hosts)
  await setSetting(APPROVED_PROVIDER_HOSTS_SETTING, normalized)
  return normalized
}

export async function rememberApprovedProviderHost(host: string): Promise<void> {
  const key = normalizeHostname(host)
  const current = getApprovedProviderHosts()
  if (current.includes(key)) return
  await setApprovedProviderHosts([...current, key])
}

export function providerAllowUserApprovalEnabled(): boolean {
  return getSetting<boolean>(PROVIDER_ALLOW_USER_APPROVAL_SETTING, true)
}

/**
 * Ensure a custom provider's host is approved before persisting or contacting it.
 * Built-in / local hosts pass without prompting.
 */
export async function ensureProviderHostApproved(baseUrl: string): Promise<void> {
  const approved = getApprovedProviderHosts()
  if (isProviderHostAllowed(baseUrl, approved)) return

  const host = providerHostKey(baseUrl)
  if (!providerAllowUserApprovalEnabled()) {
    throw new Error(
      `Provider host "${host}" is not approved. Enable "Ask before allowing new provider hosts" in Settings → Security, or add it under Approved provider hosts.`,
    )
  }

  const { approved: ok } = await requestApproval({
    title: 'Allow model provider host?',
    body: [
      'Your API key and prompts will be sent to this host:',
      '',
      host,
      '',
      `Base URL: ${baseUrl.trim()}`,
      '',
      'Approve to always allow this provider host (saved in Settings).',
    ].join('\n'),
    type: 'web',
    allowRemember: false,
  })
  if (!ok) {
    throw new Error(`Provider host "${host}" was not approved.`)
  }
  await rememberApprovedProviderHost(host)
}

/** Runtime gate helper — throws with the shared policy message when blocked. */
export function assertApprovedProviderHost(baseUrl: string): void {
  assertProviderHostAllowed(baseUrl, getApprovedProviderHosts())
}
