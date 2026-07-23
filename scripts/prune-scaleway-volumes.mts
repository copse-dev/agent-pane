#!/usr/bin/env node
import {
  DEFAULT_SCW_VOLUME_PRUNE_AGE_HOURS,
  type FleetTags,
  hasFlag,
  nonNegativeInt,
  option,
  optionWithDefault,
  type Options,
  parseOptions,
  reconcileScalewayManagedVolumes,
  requireScalewayTool,
  SCALEWAY_ZONES,
} from './lib/cloud-hosts.mts'

const MANAGED_FLEETS: FleetTags[] = [
  { kind: 'copse-burst', managedBy: 'copse-burst-runners' },
  { kind: 'copse-remote-e2e', managedBy: 'copse-remote-e2e-hosts' },
  { kind: 'copse-terminal-bench', managedBy: 'copse-terminal-bench-fleet' },
]

export interface PruneConfig {
  cutoff: Date
  zones: string[]
}

export function pruneConfig(options: Options, now = new Date()): PruneConfig {
  const ageHours = nonNegativeInt(
    optionWithDefault(options, 'older-than-hours', String(DEFAULT_SCW_VOLUME_PRUNE_AGE_HOURS)),
    'older-than-hours',
  )
  const zone = option(options, 'zone')
  return {
    cutoff: new Date(now.getTime() - ageHours * 60 * 60 * 1000),
    zones: zone ? [zone] : [...SCALEWAY_ZONES],
  }
}

function usage(): string {
  return `Usage:
  npm run scaleway:prune-volumes -- --yes [--older-than-hours 24] [--zone fr-par-1]

Deletes only unattached Block Storage volumes carrying a known Copse fleet's
kind and managed-by tags. Volumes still attached to a resource, untagged
volumes, and volumes detached more recently than the age threshold are kept.`
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
    const result = reconcileScalewayManagedVolumes({ tags }, config.zones, config.cutoff)
    const retained = result.remaining.filter(
      (volume) => volume.status === 'available' && volume.referenceCount === 0,
    ).length
    console.log(
      `==> ${tags.kind}: deleted ${String(result.deleted)}/${String(result.candidates)} eligible volume(s); ` +
        `${String(retained)} managed unattached volume(s) retained`,
    )
    failures += result.failedIds.length
  }
  if (failures > 0) throw new Error(`failed to delete ${String(failures)} managed volume(s)`)
}

if (process.argv[1]?.endsWith('prune-scaleway-volumes.mts')) {
  try {
    main()
  } catch (error) {
    console.error(
      `scaleway volume prune: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
