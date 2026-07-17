// Turn-tree identity — the epoch every async hook dispatch carries (decision 16).
//
// A *turn tree* is everything descending from one human-originated submission
// (glossary, docs/plans/hooks-and-feature-packs.md). Its id is the **epoch**:
// every detached async hook dispatch carries the id of the turn tree that
// emitted it, so a late output can be checked for staleness before it is allowed
// to abort or auto-submit (decision 16). C1 only *carries* the id on every
// dispatch; the staleness check on outputs is C2/C3 — this module gives those
// phases a type that cannot be confused with a plain string.
//
// Branded so an arbitrary `string` is not accidentally accepted where a turn-tree
// id is required (execution-guidance rule 3, "make illegal states
// unrepresentable"). Construction goes through {@link asTurnTreeId} — the single
// sanctioned cast — so call sites never hand-brand.
//
// Lives in `packages/agent` (Electron-free); the host builds the id from the
// active run's turn identity and hands it to the executor (rule 4).

declare const turnTreeIdBrand: unique symbol

/**
 * The id of a turn tree — the epoch an async hook dispatch belongs to. A branded
 * `string`: assignable *to* `string`, but a plain `string` is not assignable to
 * it without {@link asTurnTreeId}.
 */
export type TurnTreeId = string & { readonly [turnTreeIdBrand]: 'TurnTreeId' }

/**
 * Brand a raw string as a {@link TurnTreeId}. The single place the brand cast
 * lives — the host calls it once at the fire site with the emitting run's turn
 * identity, so every dispatch downstream carries a properly-typed epoch.
 */
export function asTurnTreeId(raw: string): TurnTreeId {
  return raw as TurnTreeId
}
