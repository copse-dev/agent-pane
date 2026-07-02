import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { containedSandboxNetworkConfig } from './config.ts'

/**
 * Scoped widening of ASRT's **global** network allowlist.
 *
 * ASRT's http/socks proxies decide allow/deny per connection against the
 * global `SandboxManager` config — the per-spawn `customConfig` overlay only
 * controls whether network restriction is wired up and the seatbelt
 * *filesystem* profile. So a sandboxed ACP agent's `allowedDomains` (issue
 * #590) must be lifted into the global config for the lifetime of the agent
 * process, or every connection 403s against the deny-all base regardless of
 * the overlay.
 *
 * Scopes are refcounted: the effective allowlist is the union of all active
 * scopes, and when the last one releases the config drops back to the
 * contained deny-all base. Trade-off, documented deliberately: while an ACP
 * agent scope is active, *other* sandbox-contained processes (auto-run
 * `run_shell` commands) can also reach the scope's domains. That widens the
 * M6-style exfiltration surface to the agent's own vendor domains for the
 * duration of a turn — bounded, but real; per-connection attribution would
 * need upstream ASRT support.
 */
export interface SandboxNetworkScope {
  domains: readonly string[]
  allowLocalBinding: boolean
}

const activeScopes = new Set<SandboxNetworkScope>()

/** Union the active scopes into a network config; deny-all when none. Pure. */
export function mergedScopeNetwork(
  scopes: readonly SandboxNetworkScope[],
): NonNullable<SandboxRuntimeConfig['network']> {
  if (scopes.length === 0) return containedSandboxNetworkConfig()
  const domains = new Set<string>()
  let allowLocalBinding = false
  for (const scope of scopes) {
    for (const domain of scope.domains) domains.add(domain)
    allowLocalBinding = allowLocalBinding || scope.allowLocalBinding
  }
  return { allowedDomains: [...domains], deniedDomains: [], allowLocalBinding }
}

function applyScopes(): void {
  // No-op when ASRT never initialized (sandbox off / non-macOS): there is no
  // proxy consulting the config, and nothing to widen.
  const config = SandboxManager.getConfig()
  if (!config) return
  SandboxManager.updateConfig({ ...config, network: mergedScopeNetwork([...activeScopes]) })
}

/**
 * Add a scope to the global allowlist; returns an idempotent release. Acquire
 * BEFORE spawning the process the scope is for, so its first connection never
 * races the config swap; release when the process closes.
 */
export function acquireSandboxNetworkScope(scope: SandboxNetworkScope): () => void {
  activeScopes.add(scope)
  applyScopes()
  let released = false
  return () => {
    if (released) return
    released = true
    activeScopes.delete(scope)
    applyScopes()
  }
}
