/**
 * Finishes what a lazy migration starts.
 *
 * Secrets are upgraded to the current cipher format on read (`settings.ts`,
 * `vnc-username-store.ts`): open a legacy blob, rewrite it. On its own that
 * leaves every secret nobody happens to read still in the old format — a key
 * for a provider you configured once and never switched back to keeps its
 * `safeStorage` blob indefinitely, so the legacy cipher can never be retired
 * on a release schedule without stranding it.
 *
 * So the first successful rewrite sweeps the rest. A rewrite proves the thing
 * that is actually in doubt — that the keyring is reachable and writable right
 * now — which is why the sweep hangs off that event rather than off boot,
 * where a locked keyring would waste the attempt and a Keychain prompt would
 * land in the middle of startup.
 *
 * Stores register their own sweep; nothing here knows what a secret is. That
 * keeps the dependency edges pointing one way (`settings` and `vnc` import
 * this; this imports nothing) and lets a store that loads late still take
 * part — {@link registerSecretSweep} runs immediately if the sweep it is
 * handed missed the request that already went out.
 *
 * The "once" is per process and deliberately not persisted: a sweep that dies
 * half-way through a keyring that re-locks leaves legacy blobs behind, and the
 * next read of one of them starts the whole thing over on the next launch.
 */

/** Rewrites every legacy-format secret one store owns. */
export type SecretSweep = () => void

const sweeps = new Set<SecretSweep>()
let requested = false

/**
 * Register a store's sweep. Runs it straight away when a sweep has already
 * been requested in this process, so load order cannot cost a store its turn.
 */
export function registerSecretSweep(sweep: SecretSweep): void {
  sweeps.add(sweep)
  if (requested) runSweep(sweep)
}

/**
 * Called by a store that has just migrated one secret. The first call runs
 * every registered sweep; later calls — including the re-entrant ones from
 * rewrites the sweep itself performs — do nothing.
 */
export function requestSecretSweep(): void {
  if (requested) return
  requested = true
  for (const sweep of sweeps) runSweep(sweep)
}

function runSweep(sweep: SecretSweep): void {
  try {
    sweep()
  } catch (error) {
    // A sweep is opportunistic: the secret that triggered it is already
    // migrated and readable, and anything left behind is retried next launch.
    console.warn(
      '[copse-panel] a secret-format sweep failed:',
      error instanceof Error ? error.message : error,
    )
  }
}

/** Tests only: forget registered sweeps and the once-per-process latch. */
export function resetSecretSweeps(): void {
  sweeps.clear()
  requested = false
}
