// The ACP agent catalog: one JSON file carrying everything Copse knows about
// external ACP agents, loaded from `src/shared/data/acp-metadata.json` and
// validated with zod at import time.
//
// The file has four sections with two different owners:
//
//  - `registry` — a PINNED snapshot of the public ACP registry
//    (github.com/agentclientprotocol/registry): names, versions, descriptions,
//    icons, and distribution (version-pinned npx package specs; binary
//    platform lists). Updated only by `pnpm run sync:acp-registry`, which
//    adopts the newest upstream release at least `cooldownDays` (7) old — a
//    supply-chain cooldown, same reasoning as our Dependabot cooldowns.
//  - `curated`, `retired`, `legacyIds` — hand-maintained. `curated` is the
//    per-agent overlay Copse itself is responsible for: how to spawn the agent
//    (command/args), seatbelt confinement, sign-in commands, env hints. The
//    sync script never touches these.
//
// The merge rule: a curated entry must name an id present in the pinned
// registry (or be retired) — enforced at load. Registry facts (version,
// description, icon, pinned install spec) always come from the snapshot;
// spawn/security facts always come from the overlay. Registry-only agents
// (no overlay) are browsable/installable but have no curated command, no
// seatbelt preset, and are never auto-detected — detection by guessed binary
// name could match an unrelated executable and register it as an agent.
//
// Install policy, derived per agent:
//  - `npx` distribution -> installable: `sfw npm install -g <pinned spec>`
//    (Socket Firewall scans the pinned package; the npx spec pins the exact
//    version the snapshot was reviewed with). We never run bare `npx` at
//    spawn time — that would download and execute unscanned code.
//  - `binary` distribution -> manual: shown as guidance only. The registry's
//    binary archives are not uniformly checksummed (`sha256Complete` records
//    whether every platform carries a digest), and Copse has no scanner for
//    opaque archives, so we never download them.
//  - `uvx` -> manual for now (no PyPI scanning path).
//
// See docs/acp-agents.md § "The agent catalog and the registry pin".

import { z } from 'zod'
import catalog from './data/acp-metadata.json' with { type: 'json' }

const distributionSchema = z
  .object({
    npx: z
      .object({ package: z.string().min(1), args: z.array(z.string()).optional() })
      .strict()
      .optional(),
    uvx: z
      .object({ package: z.string().min(1), args: z.array(z.string()).optional() })
      .strict()
      .optional(),
    binary: z
      .object({ platforms: z.array(z.string().min(1)).min(1), sha256Complete: z.boolean() })
      .strict()
      .optional(),
  })
  .strict()

const registryAgentSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1),
    license: z.string().min(1),
    repository: z.string().optional(),
    website: z.string().optional(),
    icon: z.url().startsWith('https://').optional(),
    distribution: distributionSchema,
  })
  .strict()

const sandboxSchema = z
  .object({
    allowedDomains: z.array(z.string().min(1)),
    homeDirs: z.array(z.string().min(1)).optional(),
    scratchPaths: z.array(z.string().min(1)).optional(),
  })
  .strict()

const curatedAgentSchema = z
  .object({
    title: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()),
    envHints: z.array(z.string().min(1)).optional(),
    install: z.string().min(1).optional(),
    installPackage: z.string().min(1).optional(),
    requiresClient: z.string().min(1).optional(),
    autoInstall: z.boolean().optional(),
    preset: z.boolean().optional(),
    sandbox: sandboxSchema.optional(),
    sandboxedPermissionMode: z.string().min(1).optional(),
    setup: z.string().min(1).optional(),
    reauth: z.string().min(1).optional(),
    docsUrl: z.url().startsWith('https://').optional(),
    note: z.string().min(1).optional(),
    comment: z.string().optional(),
  })
  .strict()

const retiredAgentSchema = curatedAgentSchema
  .extend({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    reason: z.string().min(1),
  })
  .strict()

const catalogSchema = z
  .object({
    registry: z
      .object({
        pin: z
          .object({
            tag: z.string().min(1),
            publishedAt: z.iso.datetime(),
            syncedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            cooldownDays: z.int().positive(),
            source: z.url().startsWith('https://'),
          })
          .strict(),
        agents: z.array(registryAgentSchema).min(1),
      })
      .strict(),
    curated: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), curatedAgentSchema),
    retired: z.array(retiredAgentSchema),
    legacyIds: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict()

export type AcpRegistryAgent = z.infer<typeof registryAgentSchema>
export type AcpRegistryPin = z.infer<typeof catalogSchema>['registry']['pin']
/** A curated overlay entry, comment stripped (see acp-known-agents.ts). */
export type AcpCuratedAgent = Omit<z.infer<typeof curatedAgentSchema>, 'comment'>
export type AcpRetiredCatalogAgent = Omit<z.infer<typeof retiredAgentSchema>, 'comment'>

const parsed = catalogSchema.parse(catalog)

// ---- Load-time invariants the schema cannot express ----

{
  const registryIds = new Set(parsed.registry.agents.map((agent) => agent.id))
  const retiredIds = new Set(parsed.retired.map((agent) => agent.id))
  for (const id of Object.keys(parsed.curated)) {
    // A curated overlay for an id the pinned registry no longer carries is a
    // stale entry, not a harmless extra: its version/install spec would be
    // unverifiable. Retire it explicitly instead.
    if (!registryIds.has(id) && !retiredIds.has(id)) {
      throw new Error(
        `acp-metadata: curated agent '${id}' is neither in the pinned registry nor retired`,
      )
    }
  }
  for (const [legacy, current] of Object.entries(parsed.legacyIds)) {
    if (retiredIds.has(legacy)) {
      // A retirement is not a rename; aliasing a retired id would make old
      // threads claim they ran something they did not (see acp-known-agents.ts).
      throw new Error(`acp-metadata: '${legacy}' is retired and must not also be a legacy alias`)
    }
    if (!registryIds.has(current)) {
      throw new Error(`acp-metadata: legacy id '${legacy}' points at unknown agent '${current}'`)
    }
  }
}

/** The pinned registry snapshot's provenance (tag, dates, cooldown). */
export const ACP_REGISTRY_PIN: AcpRegistryPin = parsed.registry.pin

/** Every agent in the pinned registry snapshot, id-sorted. */
export const ACP_REGISTRY_AGENTS: readonly AcpRegistryAgent[] = parsed.registry.agents

const registryById = new Map(parsed.registry.agents.map((agent) => [agent.id, agent]))

/** Registry snapshot entry for an id, or undefined for retired/unknown ids. */
export function acpRegistryAgent(id: string): AcpRegistryAgent | undefined {
  return registryById.get(id)
}

/**
 * The version-pinned npm spec for an agent's npx distribution, or null. This is
 * what the installer feeds Socket Firewall: the exact version the pinned
 * snapshot was reviewed with, never `latest`.
 */
export function pinnedNpxSpec(id: string): string | null {
  return registryById.get(id)?.distribution.npx?.package ?? null
}

/**
 * A PATH-command suggestion for a registry agent's npx package: the package
 * basename without scope or version pin (`@scope/name@1.2.3` -> `name`). Only a
 * prefill for the custom-agent form — never used to auto-detect, since a
 * guessed name could match an unrelated binary.
 */
export function suggestedCommandFromNpx(pkg: string): string {
  const withoutVersion = pkg.replace(/(.)@[^@/]+$/, '$1')
  return withoutVersion.split('/').pop() ?? withoutVersion
}

/** Internal: catalog sections consumed by acp-known-agents.ts. */
export const ACP_CATALOG = parsed
