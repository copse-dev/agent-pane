// First-party packs — P1 scaffold of the feature-pack layer.
//
// The static list of packs Copse ships. Following decision 15 (VS Code's
// built-in-extensions model), first-party packs share the manifest, registry,
// and disable semantics with user packs; they additionally supply typed runtime
// contributions (native tools, in-process function hooks, real renderer views).
//
// P1 deliberately ships only a skeleton "noop" pack: it proves the lifecycle end
// to end (registry grouping, atomic enable/disable, the `createHookRegistry`
// seam) without extracting any behavior. The real pilot pack — todos — lands in
// P4 by adding its manifest + typed hooks/tool here; nothing in the loop changes
// because the loop already sources pack hooks through this list (decision 17's
// dead-code note: the pack is referenced by the registry, not the loop).
import { definePack, type RegisteredPack } from './pack-manifest.ts'
import { PackRegistry } from './pack-registry.ts'

/**
 * The P1 skeleton first-party pack. Contributes nothing (empty contributions),
 * so registering it and folding its hooks into `createHookRegistry` is
 * byte-identical to not having it. It exists purely so the lifecycle is wired
 * before P4 fills in the todos pack's tool / hooks / prompt / panel.
 */
export const noopPack: RegisteredPack = definePack({
  name: 'copse.noop',
  description:
    'P1 skeleton pack — proves the pack lifecycle; contributes nothing (todos land in P4).',
  trust: 'first-party',
  storage: { namespace: 'copse.noop' },
})

/** Every pack Copse ships. P4 appends the todos pack here. */
export const FIRST_PARTY_PACKS: readonly RegisteredPack[] = [noopPack]

/** A fresh {@link PackRegistry} seeded with the shipped first-party packs (all enabled). */
export function createFirstPartyPackRegistry(): PackRegistry {
  const registry = new PackRegistry()
  for (const pack of FIRST_PARTY_PACKS) registry.register(pack)
  return registry
}
