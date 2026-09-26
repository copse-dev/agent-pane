import type { LLMProvider } from '@shared/types'
import {
  buildProviderFromDescription,
  providerEndpointUrl,
  type ProviderDescription,
} from '../providers/provider-description.ts'
import { HOST_LOCAL_ALIAS } from './egress-rules.ts'

/**
 * The model client the guest runs its loop on: the desktop's own resolution
 * of the model, built from its description with the run's one key, since the
 * guest has no settings to resolve anything from.
 *
 * The endpoint's host counts as approved: the desktop admitted it to the
 * allowlist when it described the provider. The host-local alias counts as
 * loopback, so a server on the desktop's loopback keeps its plain http here as
 * it has there (`docs/plans/thread-in-container.md`, A16) — and only the alias:
 * any other plain-http host is refused as it is on the desktop. The host holds
 * up its end: no run starts, and no broker is built, that would dial the alias
 * anywhere but its own loopback (`hostLocalAliasRefusal`): the alias maps to
 * `127.0.0.1`, `::1` or `localhost`, and the broker answers `localhost` with
 * loopback itself rather than asking a resolver.
 */
export function buildGuestProvider(
  description: ProviderDescription,
  apiKey: string | null,
): LLMProvider {
  return buildProviderFromDescription(description, {
    apiKey,
    approvedHosts: [new URL(providerEndpointUrl(description)).hostname],
    hostLocalAlias: HOST_LOCAL_ALIAS,
  })
}
