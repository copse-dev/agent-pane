import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { PROTOCOL_VERSION as V2_PROTOCOL_VERSION } from '@agentclientprotocol/sdk/experimental/v2'
import { isRecord } from '../../../shared/unknown-value.mts'

/**
 * PROTOTYPE — the version-negotiation seam for ACP v2 (docs/acp-v2-readiness.md).
 *
 * Copse speaks protocol v1. Adopting v2 is not a flag flip because the SDK gives
 * us two *different clients*: `client()` (v1) and `experimental/v2`'s `client()`.
 * They are chosen at construction, before a byte is sent — so something has to
 * decide which to build.
 *
 * The obvious design, "build the v2 client and let it fall back", does not work,
 * and the reason is worth recording because it is not in the migration guide:
 *
 *   - The PROTOCOL downgrades correctly. Ask a v1-only agent for
 *     `protocolVersion: 2` and it answers `1`, exactly as ACP specifies.
 *   - The SDK's v2 CLIENT does not. It parses the initialize response against the
 *     v2 schema before looking at the version, so a v1 answer (which has
 *     `agentCapabilities` and no `info`) dies as a **ZodError on a missing
 *     `info`** — not as the version mismatch `mapV2InitializeResponse` raises
 *     when the shapes happen to line up.
 *
 * That failure is indistinguishable from a genuinely broken agent, so
 * try-v2-and-catch would silently treat a sick agent as a v1 one. Hence this
 * module: negotiate FIRST with a schema-free `initialize`, read the version the
 * agent actually answered, and only then build the typed client for it.
 *
 * The cost is one extra round trip. In the product that lands as a probe on a
 * short-lived connection whose result is cached per agent — the same shape as
 * `availableModels` on {@link AcpAgentConfig}, which is already cached with a
 * staleness TTL for exactly this reason.
 *
 * Not wired into `acp-client.ts` or the session pool: this is the seam and its
 * decision rules, with the transport injected so both are testable.
 */

export type AcpProtocolVersion = 1 | 2

/** The version Copse's shipping client speaks; every default routes here. */
export const DEFAULT_PROTOCOL_VERSION: AcpProtocolVersion = PROTOCOL_VERSION

/** The version the SDK's experimental v2 entry point speaks. */
export const EXPERIMENTAL_PROTOCOL_VERSION: AcpProtocolVersion = V2_PROTOCOL_VERSION

export interface AcpClientInfo {
  name: string
  version: string
}

/**
 * `initialize` params for a given version. The shapes differ beyond the version
 * number: v2 folds the client's capabilities into one `capabilities` object and
 * adds a REQUIRED `info`, which v1 has no field for.
 */
export function initializeParams(
  version: AcpProtocolVersion,
  info: AcpClientInfo,
): Record<string, unknown> {
  if (version === 2) {
    return { protocolVersion: 2, info, capabilities: {} }
  }
  return {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  }
}

/**
 * The version an agent answered, read from an unvalidated initialize response.
 *
 * Deliberately schema-free: validating against either version's schema is what
 * makes the typed clients unable to do this themselves. Anything that is not a
 * version we can drive reads as `null` — including a *newer* protocol than we
 * know about, which must not be mistaken for one we can speak.
 */
export function negotiatedVersion(response: unknown): AcpProtocolVersion | null {
  if (!isRecord(response)) return null
  const version = response['protocolVersion']
  if (version === 1) return 1
  if (version === 2) return 2
  return null
}

export interface NegotiationOutcome {
  /** The version Copse asked for. */
  requested: AcpProtocolVersion
  /** The version the agent answered, or null when it is one we cannot drive. */
  answered: AcpProtocolVersion | null
  /** The client to build. Never null: an unusable answer falls back to v1. */
  selected: AcpProtocolVersion
  /** True when the agent answered something older than we asked for. */
  downgraded: boolean
}

/**
 * Decide which typed client to build from what we asked for and what came back.
 *
 * An answer we cannot drive (a protocol newer than this build, or a malformed
 * response) selects v1 rather than failing: v1 is what every agent in the
 * catalog speaks today, so the conservative choice keeps a session working
 * instead of trading a live feature for an unusable one.
 */
export function selectProtocol(
  requested: AcpProtocolVersion,
  response: unknown,
): NegotiationOutcome {
  const answered = negotiatedVersion(response)
  const selected = answered ?? DEFAULT_PROTOCOL_VERSION
  return { requested, answered, selected, downgraded: answered !== null && answered < requested }
}

/** Sends one `initialize` and returns the raw, unparsed response. */
export type InitializeTransport = (params: Record<string, unknown>) => Promise<unknown>

/**
 * Ask an agent which protocol it will speak, without committing to a client.
 *
 * `preferred` is the version to try first — in the product this comes from
 * per-agent configuration rather than a global switch, because an install
 * routinely has one v2-capable agent and several v1 ones, and a single toggle
 * would be wrong for most of them.
 */
export async function negotiateProtocol(
  transport: InitializeTransport,
  preferred: AcpProtocolVersion,
  info: AcpClientInfo,
): Promise<NegotiationOutcome> {
  return selectProtocol(preferred, await transport(initializeParams(preferred, info)))
}
