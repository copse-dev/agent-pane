/**
 * The egress allowlist grammar, shared by the host broker and the guest proxy
 * (`docs/plans/thread-in-container.md`, decision A2).
 *
 * A rule is `host:port` or `*.suffix:port`. The wildcard form exists because the
 * things a run has to reach are not always one host: an OpenAI-compatible
 * endpoint is, but an agent's vendor moves OAuth refresh between subdomains,
 * and the ACP catalogue declares `*.anthropic.com`-style domains for exactly
 * that reason. `*.suffix` admits `a.suffix` and `a.b.suffix` and refuses
 * `suffix` itself and `notsuffix` — a suffix match on the dot boundary, never a
 * substring one.
 *
 * Nothing here dials or listens. It is pure so both sides of the socket can
 * share it and so it can be tested without either.
 */

export interface EgressRule {
  /** Exact host, or the suffix when `wildcard` is set (without the `*.`). */
  host: string
  wildcard: boolean
  port: number
}

/**
 * Where the guest proxy listens. Fixed rather than ephemeral because Node reads
 * `HTTPS_PROXY` once at startup under `NODE_USE_ENV_PROXY=1`, so the address
 * has to be known before the worker process exists. The guest is single-tenant,
 * so a fixed loopback port has no one to collide with.
 */
export const GUEST_EGRESS_PROXY = { host: '127.0.0.1', port: 3128 } as const

/** The one broker socket, by name; the host keeps it in a short per-run directory. */
export const BROKER_SOCKET_NAME = 'broker.sock'

const RULE =
  /^(\*\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*):(\d{1,5})$/i

export function parseEgressRule(value: string): EgressRule {
  const match = RULE.exec(value.trim())
  if (!match) {
    throw new Error(`Egress rule must be host:port or *.suffix:port, got "${value}"`)
  }
  const port = Number(match[3])
  if (port < 1 || port > 65535) throw new Error(`Egress port out of range: ${value}`)
  const host = (match[2] ?? '').toLowerCase()
  const wildcard = match[1] !== undefined
  // `*.com` would admit the internet one dot at a time. A wildcard needs a
  // suffix with at least one dot of its own, so the narrowest it can be is a
  // registrable domain.
  if (wildcard && !host.includes('.')) {
    throw new Error(`A wildcard egress rule needs a dotted suffix, got "${value}"`)
  }
  return { host, wildcard, port }
}

export function formatEgressRule(rule: EgressRule): string {
  return `${rule.wildcard ? '*.' : ''}${rule.host}:${String(rule.port)}`
}

/** Whether one rule admits a concrete target. */
export function egressRuleAllows(rule: EgressRule, host: string, port: number): boolean {
  if (port !== rule.port) return false
  const candidate = host.toLowerCase()
  if (!rule.wildcard) return candidate === rule.host
  return candidate.length > rule.host.length + 1 && candidate.endsWith(`.${rule.host}`)
}

/** The first rule admitting a target, or null when nothing does. */
export function findEgressRule(
  rules: readonly EgressRule[],
  host: string,
  port: number,
): EgressRule | null {
  return rules.find((rule) => egressRuleAllows(rule, host, port)) ?? null
}

/**
 * Parse the `host:port` a CONNECT line or absolute-form URL names. Ports are
 * mandatory on the wire here; the guest proxy fills the scheme default in
 * before it gets this far.
 */
export function parseEgressTarget(value: string): { host: string; port: number } | null {
  const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(value.trim())
  if (!match) return null
  const port = Number(match[2])
  if (port < 1 || port > 65535) return null
  return { host: (match[1] ?? '').toLowerCase(), port }
}
