// The pack registry — P1 of the feature-pack layer.
//
// One registry groups every pack's contributions by pack id (tools / hooks /
// prompt / ui / settings / storage) and owns the pack *lifecycle*: atomic
// enable/disable. Disabling a pack removes all of its contributions from **new
// work** in one action — tools leave the model tool list, hooks stop firing,
// prompt blocks drop out, UI contributions stop mounting for new content — while
// its storage persists like a disabled browser extension's data (decision 17).
//
// Critically, the registry is consulted only for *new work*. History / transcript
// rendering resolves from shipped renderer code + spine data and **never** calls
// into this registry (decision 17); the registry exposes no method that maps a
// historical record through live enablement, which is what makes that invariant
// mechanical rather than a convention (see the
// history-never-consults-live-registration contract test).
//
// Electron-free (execution-guidance rule 4): pure in-memory state. Persisting
// the enable/disable set + pack storage to `electron-store` is host wiring that
// lands with the Settings pack-list UI (P3).
import type {
  PackCapabilityDecl,
  PackContributions,
  PackPermissionDecl,
  PackUiContribution,
  PackPromptBlock,
  RegisteredPack,
} from './pack-manifest.ts'
import type { AsyncHook, BlockingHook } from '../hooks/canonical-events.ts'

/** A pack and its current enablement, for the Settings pack list (P3). */
export interface PackGrouping {
  readonly pack: RegisteredPack
  readonly enabled: boolean
}

/**
 * Namespaced, disable-surviving storage for one pack (decision 17). A thin view
 * over the registry's per-pack bag; the concrete persistence backend is injected
 * host-side in P3. `get` returns `unknown` — the registry never inspects the
 * value, so the caller narrows it rather than the registry casting on its behalf.
 */
export interface PackStorage {
  get(key: string): unknown
  set(key: string, value: unknown): void
  has(key: string): boolean
  keys(): readonly string[]
}

/** Thrown when a lifecycle call names a pack that was never registered. */
export class UnknownPackError extends Error {
  readonly packId: string
  constructor(packId: string) {
    super(`no pack registered with id "${packId}"`)
    this.name = 'UnknownPackError'
    this.packId = packId
  }
}

/** Thrown when two packs register under the same id (grouping must be unique). */
export class DuplicatePackError extends Error {
  readonly packId: string
  constructor(packId: string) {
    super(`a pack with id "${packId}" is already registered`)
    this.name = 'DuplicatePackError'
    this.packId = packId
  }
}

/**
 * Thrown when a pack registers a level-2 UI contribution without a `panel` decl.
 * The invariant is mechanical (rather than "please remember to add one"): a
 * level-2 contribution *is* a declarative panel, so the shape must be pinned at
 * registration or the host has nothing to validate incoming `panel_update`
 * payloads against (P2).
 */
export class InvalidPanelContributionError extends Error {
  readonly packId: string
  readonly contributionId: string
  constructor(packId: string, contributionId: string, reason: string) {
    super(`pack "${packId}" contribution "${contributionId}" is invalid: ${reason}`)
    this.name = 'InvalidPanelContributionError'
    this.packId = packId
    this.contributionId = contributionId
  }
}

export class PackRegistry {
  // Insertion-ordered so `all()` / the active getters keep a deterministic
  // order (contribution order can be load-bearing, e.g. prompt assembly).
  private readonly packs = new Map<string, RegisteredPack>()
  // Disabled ids. A pack is enabled unless present here — so registering a pack
  // enables it by default, matching VS Code's built-in-extension model.
  private readonly disabledIds = new Set<string>()
  // Per-pack storage bag, keyed by pack id. Never cleared on disable (decision
  // 17): the entry outlives the pack's active registration.
  private readonly storageByPack = new Map<string, Map<string, unknown>>()

  /** Register a pack, grouped by its id. Enabled by default. Duplicate id throws. */
  register(pack: RegisteredPack): void {
    if (this.packs.has(pack.id)) throw new DuplicatePackError(pack.id)
    for (const contribution of pack.contributions.uiContributions) {
      if (contribution.level === 2 && !contribution.panel) {
        throw new InvalidPanelContributionError(
          pack.id,
          contribution.id,
          'level 2 (declarative panel) requires a `panel` decl (kind: list | tree)',
        )
      }
      // The inverse is equally mechanical: a `panel` decl on a level-1 card or a
      // level-3 real view is meaningless — reject it so a typo'd level never
      // ships a panel the host will silently ignore.
      if (contribution.level !== 2 && contribution.panel) {
        throw new InvalidPanelContributionError(
          pack.id,
          contribution.id,
          `level ${String(contribution.level)} must not declare a \`panel\` — panels are the level-2 contract`,
        )
      }
    }
    this.packs.set(pack.id, pack)
  }

  /** Every registered pack in registration order (Settings enumeration, P3). */
  all(): readonly RegisteredPack[] {
    return [...this.packs.values()]
  }

  get(id: string): RegisteredPack | undefined {
    return this.packs.get(id)
  }

  has(id: string): boolean {
    return this.packs.has(id)
  }

  /** True when the pack is registered and not disabled. */
  isEnabled(id: string): boolean {
    return this.packs.has(id) && !this.disabledIds.has(id)
  }

  /**
   * Enable a registered pack (a no-op when already enabled). Its contributions
   * re-enter the active set for new work immediately; its persisted storage —
   * which was never cleared — is unchanged.
   */
  enable(id: string): void {
    if (!this.packs.has(id)) throw new UnknownPackError(id)
    this.disabledIds.delete(id)
  }

  /**
   * Disable a registered pack **atomically**: a single flag flip drops every one
   * of its contribution kinds from the active getters at once (tools, hooks,
   * prompt blocks, UI). There is no partial state — the active set is recomputed
   * from `disabledIds`, so it can never show a pack's tools without its hooks.
   * Storage is deliberately untouched (decision 17).
   */
  disable(id: string): void {
    if (!this.packs.has(id)) throw new UnknownPackError(id)
    this.disabledIds.add(id)
  }

  private enabledPacks(): RegisteredPack[] {
    return this.all().filter((pack) => !this.disabledIds.has(pack.id))
  }

  private collectActive<T>(select: (c: PackContributions) => readonly T[]): readonly T[] {
    const out: T[] = []
    for (const pack of this.enabledPacks()) out.push(...select(pack.contributions))
    return out
  }

  /** Native tool names offered to the model right now (enabled packs only). */
  activeToolNames(): readonly string[] {
    return this.collectActive((c) => c.toolNames)
  }

  /** Blocking function hooks to register for new work (enabled packs only). */
  activeBlockingHooks(): readonly BlockingHook[] {
    return this.collectActive((c) => c.blockingHooks)
  }

  /** Async (detached) function hooks to register for new work (enabled packs only). */
  activeAsyncHooks(): readonly AsyncHook[] {
    return this.collectActive((c) => c.asyncHooks)
  }

  /** Prompt / steering blocks folded into assembly right now (enabled packs only). */
  activePromptBlocks(): readonly PackPromptBlock[] {
    return this.collectActive((c) => c.promptBlocks)
  }

  /** UI contributions that mount for new content right now (enabled packs only). */
  activeUiContributions(): readonly PackUiContribution[] {
    return this.collectActive((c) => c.uiContributions)
  }

  /**
   * Capability flags active right now — every capability declared by an enabled
   * pack (enabled packs only). Disabling the owning pack drops its capabilities
   * from this getter in the same atomic flag flip that drops its tools/hooks
   * (decision 15).
   */
  activeCapabilities(): readonly PackCapabilityDecl[] {
    return this.collectActive((c) => c.capabilities)
  }

  /**
   * Whether a named capability is active — the single seam main and renderer
   * consult instead of a scattered standalone `getSetting` read. A capability is
   * active iff some *enabled* pack declares it, so disabling that pack turns the
   * behaviour off atomically.
   */
  isCapabilityActive(name: string): boolean {
    return this.activeCapabilities().some((capability) => capability.name === name)
  }

  /**
   * Permission / sandbox relaxations declared right now — every relaxation a
   * still-enabled pack contributes (enabled packs only). Disabling the owning
   * pack drops its relaxations from this getter in the same atomic flag flip
   * that drops its tools/hooks (issue #1190), so the permission-gate stops
   * honouring the declared authority the moment the pack is off.
   */
  activePermissions(): readonly PackPermissionDecl[] {
    return this.collectActive((c) => c.permissions)
  }

  /**
   * Whether a named permission / sandbox relaxation is declared by an enabled
   * pack — the seam the permission-gate consults before offering or honouring a
   * declared relaxation (issue #1190). A relaxation is grantable iff some
   * *enabled* pack declares it, so disabling that pack revokes the authority
   * atomically (mirrors {@link isCapabilityActive}).
   */
  isPermissionDeclared(name: string): boolean {
    return this.activePermissions().some((permission) => permission.name === name)
  }

  /**
   * Active level-2 declarative panels, each paired with its owning pack id (P2).
   * The host mounts one generic list/tree component per entry into the named
   * `slot`; disabling the owning pack drops it from this getter in one action,
   * so panels for new content stop mounting alongside the pack's other
   * contribution kinds (decision 15 atomicity). Historical content is
   * unaffected — history renders from spine data, never the registry
   * (decision 17).
   */
  activePanelContributions(): readonly {
    readonly packId: string
    readonly contribution: PackUiContribution
  }[] {
    const out: { packId: string; contribution: PackUiContribution }[] = []
    for (const pack of this.enabledPacks()) {
      for (const contribution of pack.contributions.uiContributions) {
        if (contribution.level === 2 && contribution.panel) {
          out.push({ packId: pack.id, contribution })
        }
      }
    }
    return out
  }

  /** Every pack + its enablement, for the Settings pack list (P3). */
  grouping(): readonly PackGrouping[] {
    return this.all().map((pack) => ({ pack, enabled: this.isEnabled(pack.id) }))
  }

  /**
   * Namespaced storage for a pack. The bag is created lazily and never cleared
   * on disable (decision 17), so a disabled pack's data is intact when it is
   * re-enabled. Throws for an unknown pack so a typo can't silently write into a
   * detached bag.
   */
  storage(id: string): PackStorage {
    if (!this.packs.has(id)) throw new UnknownPackError(id)
    let bag = this.storageByPack.get(id)
    if (!bag) {
      bag = new Map<string, unknown>()
      this.storageByPack.set(id, bag)
    }
    const store = bag
    return {
      get(key: string): unknown {
        return store.get(key)
      },
      set(key: string, value: unknown): void {
        store.set(key, value)
      },
      has(key: string): boolean {
        return store.has(key)
      },
      keys(): readonly string[] {
        return [...store.keys()]
      },
    }
  }
}
