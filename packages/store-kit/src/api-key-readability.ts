/**
 * Whether a stored API key can actually be decrypted here, cached so the answer
 * is cheap enough for the availability checks on UI render paths.
 *
 * Split out of `settings.ts` because that module is swapped for an in-memory
 * shim in unit tests (see `scripts/run-tests.mts`), which would leave this
 * decision untested. `settings.ts` keeps ownership of the stored record and the
 * cipher; this module owns only the verdict.
 */

/** The stored-key fields the verdict depends on. */
export interface StoredKeyShape {
  /** base64 of the encrypted — or, when `plain`, the unencrypted — bytes. */
  enc: string
  plain?: boolean
}

export interface KeyReadabilityProbe {
  /** Whether a usable cipher exists right now (`safeStorage.isEncryptionAvailable`). */
  encryptionAvailable: boolean
  /** Attempt the read. `null` means the ciphertext did not open. */
  readKey: () => string | null
}

/**
 * The verdict is cached against the exact ciphertext it was computed from, not
 * merely against the provider. A key rewritten by any route — `setApiKey`, or
 * another process editing settings.json — therefore recomputes on its own,
 * without every writer having to remember to invalidate.
 */
const verdicts = new Map<string, { enc: string; readable: boolean }>()

/**
 * `null` when no key is stored. `true` whenever readability cannot be
 * established rather than guessed at: with no usable cipher — a Linux keyring
 * that is not unlocked yet — a failed decrypt says nothing about the key, and
 * reporting it broken would hide a provider that works minutes later.
 */
export function resolveKeyReadability(
  provider: string,
  record: StoredKeyShape | null,
  probe: KeyReadabilityProbe,
): boolean | null {
  if (!record || !record.enc) return null
  if (record.plain) return true
  if (!probe.encryptionAvailable) return true

  const cached = verdicts.get(provider)
  if (cached?.enc === record.enc) return cached.readable

  const readable = probe.readKey() !== null
  verdicts.set(provider, { enc: record.enc, readable })
  return readable
}

/** Drop a cached verdict (or all of them) after a key is written or removed. */
export function clearKeyReadability(provider?: string): void {
  if (provider === undefined) verdicts.clear()
  else verdicts.delete(provider)
}
