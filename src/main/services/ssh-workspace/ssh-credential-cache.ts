/**
 * In-memory front-end for SSH secret answers (host password, key passphrase).
 *
 * Password-authenticated hosts prompt far more often than the single dialog a
 * user expects. Every `ssh` invocation that starts before the ControlMaster
 * socket exists authenticates on its own, so a burst of agent commands raises a
 * burst of dialogs; and once the master expires, the next command prompts
 * again. Caching the answer for the app session turns that back into "type it
 * once".
 *
 * Remembered answers for a configured host are also encrypted through the OS
 * keyring-backed credential store. Secrets never reach the renderer after the
 * initial answer. A cached and persisted secret is dropped the moment the
 * client it was handed to asks a second time, which is how OpenSSH reports a
 * rejected password: it re-execs `SSH_ASKPASS` for each attempt.
 *
 * Generations keep that invalidation correct under concurrency. Each served
 * answer records the generation it came from, and a re-ask only retires the
 * cache when the asker was served the *current* generation. Two children
 * holding the same bad password therefore raise one fresh prompt between them,
 * not two.
 */

import {
  deleteStoredSshCredential,
  deleteStoredSshCredentials,
  getStoredSshCredential,
  setStoredSshCredential,
} from './ssh-credential-store.ts'

export interface SshSecretAnswer {
  value: string
  /** False when the user declined to keep this secret for the session. */
  remember: boolean
}

interface CachedSecret {
  value: string
  generation: number
}

interface PendingAsk {
  promise: Promise<string>
  generation: number
}

const cache = new Map<string, CachedSecret>()
const generations = new Map<string, number>()
const pending = new Map<string, PendingAsk>()
/** Per-spawn askpass nonce → prompt key → generation that nonce was served. */
const servedByNonce = new Map<string, Map<string, number>>()

/** A host scope also separates identity-file prompts shared across connections. */
function cacheKey(hostId: string | undefined, prompt: string): string {
  return `${hostId ?? 'session'}\0${prompt.trim()}`
}

function markServed(nonce: string, key: string, generation: number): void {
  let served = servedByNonce.get(nonce)
  if (!served) {
    served = new Map<string, number>()
    servedByNonce.set(nonce, served)
  }
  served.set(key, generation)
}

/**
 * Answer a secret prompt from the session cache when possible, falling back to
 * `ask` (the modal) exactly once per prompt even when several clients are
 * waiting on it.
 */
export async function resolveSshSecret(
  nonce: string,
  prompt: string,
  ask: () => Promise<SshSecretAnswer>,
  hostId?: string,
): Promise<string> {
  const key = cacheKey(hostId, prompt)
  let generation = generations.get(key) ?? 0

  if (servedByNonce.get(nonce)?.get(key) === generation) {
    // This client already had the current answer and is asking again — the
    // server rejected it. Retire the generation so nobody else replays it.
    generation += 1
    generations.set(key, generation)
    cache.delete(key)
    pending.delete(key)
    if (hostId) deleteStoredSshCredential(hostId, prompt)
  }

  const cached = cache.get(key)
  if (cached) {
    markServed(nonce, key, cached.generation)
    return cached.value
  }

  const stored = hostId ? getStoredSshCredential(hostId, prompt) : null
  if (stored) {
    cache.set(key, { value: stored, generation })
    markServed(nonce, key, generation)
    return stored
  }

  const inFlight = pending.get(key)
  if (inFlight && inFlight.generation === generation) {
    markServed(nonce, key, generation)
    return inFlight.promise
  }

  const promise = ask().then((answer) => {
    if (answer.remember && answer.value && (generations.get(key) ?? 0) === generation) {
      cache.set(key, { value: answer.value, generation })
      if (hostId) setStoredSshCredential(hostId, prompt, answer.value)
    }
    return answer.value
  })
  const entry: PendingAsk = { promise, generation }
  pending.set(key, entry)
  markServed(nonce, key, generation)
  try {
    return await promise
  } finally {
    if (pending.get(key) === entry) pending.delete(key)
  }
}

/** Forget which secrets a finished spawn was served. Call when its lease ends. */
export function releaseSshCredentialNonce(nonce: string): void {
  servedByNonce.delete(nonce)
}

/** Forget both cached and OS-keyring-encrypted answers for one connection. */
export function forgetSshCredentials(hostId: string): void {
  const prefix = `${hostId}\0`
  for (const key of new Set([...cache.keys(), ...generations.keys(), ...pending.keys()])) {
    if (!key.startsWith(prefix)) continue
    cache.delete(key)
    pending.delete(key)
    generations.set(key, (generations.get(key) ?? 0) + 1)
    for (const served of servedByNonce.values()) served.delete(key)
  }
  deleteStoredSshCredentials(hostId)
}

/** Drop every remembered secret (app teardown, explicit "forget", tests). */
export function clearSshCredentialCache(): void {
  cache.clear()
  generations.clear()
  pending.clear()
  servedByNonce.clear()
}
