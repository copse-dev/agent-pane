#!/usr/bin/env node
import {
  DEFAULT_SCW_IP_PRUNE_SETTLE_SECONDS,
  type FleetTags,
  hasFlag,
  nonNegativeInt,
  option,
  optionWithDefault,
  type Options,
  parseOptions,
  reconcileScalewayManagedIps,
  requireScalewayTool,
  SCALEWAY_ZONES,
} from './lib/cloud-hosts.mts'

const MANAGED_FLEETS: FleetTags[] = [
  { kind: 'copse-burst', managedBy: 'copse-burst-runners' },
  { kind: 'copse-remote-e2e', managedBy: 'copse-remote-e2e-hosts' },
  { kind: 'copse-terminal-bench', managedBy: 'copse-terminal-bench-fleet' },
]

export interface PruneConfig {
  settleSeconds: number
  zones: string[]
}

export function pruneConfig(options: Options): PruneConfig {
  const settleSeconds = nonNegativeInt(
    optionWithDefault(options, 'settle-seconds', String(DEFAULT_SCW_IP_PRUNE_SETTLE_SECONDS)),
    'settle-seconds',
  )
  const zone = option(options, 'zone')
  return { settleSeconds, zones: zone ? [zone] : [...SCALEWAY_ZONES] }
}

function usage(): string {
  return `Usage:
  npm run scaleway:prune-ips -- --yes [--settle-seconds 120] [--zone fr-par-1]

Deletes only unattached zonal flexible IPs carrying a known Copse fleet's kind
and managed-by tags, and only when they read as unattached in two passes
separated by --settle-seconds. Attached IPs and untagged IPs are always kept.

Scaleway bills a flexible IP from reservation until deletion whether or not a
server is attached, so an orphan never stops charging on its own.`
}

function main(): void {
  const options = parseOptions(process.argv, 2)
  if (hasFlag(options, 'help')) {
    console.log(usage())
    return
  }
  if (!hasFlag(options, 'yes')) {
    throw new Error('pruning requires --yes')
  }
  requireScalewayTool()
  const config = pruneConfig(options)
  let failures = 0
  for (const tags of MANAGED_FLEETS) {
    const result = reconcileScalewayManagedIps({ tags }, config.zones, config.settleSeconds)
    const retained = result.remaining.filter((ip) => !ip.attached).length
    console.log(
      `==> ${tags.kind}: deleted ${String(result.deleted)}/${String(result.candidates)} confirmed orphan IP(s); ` +
        `${String(retained)} managed unattached IP(s) retained`,
    )
    failures += result.failedIds.length
  }
  if (failures > 0) throw new Error(`failed to delete ${String(failures)} managed flexible IP(s)`)
}

if (process.argv[1]?.endsWith('prune-scaleway-ips.mts')) {
  try {
    main()
  } catch (error) {
    console.error(`scaleway ip prune: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
