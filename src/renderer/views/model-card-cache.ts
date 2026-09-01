// Renderer-side view of resolved model cards.
//
// The hover cards are built synchronously by pure functions, but resolving a
// card URL is a network round-trip in the main process. This module bridges the
// two: it holds what has already been resolved so a tooltip can read it without
// awaiting anything, and exposes a request path that fills the gap in the
// background and tells the caller when an answer arrived.
//
// Nothing is shown until it resolves. That is deliberate — the whole point of
// probing is that a link which would 404 never reaches the user — so a model
// whose probe is still in flight simply has no card section yet, and gains one
// on the next paint.

import type { ApiClient } from '../../preload/api.d.ts'
import type { ModelCardCandidate } from '@copse/llm/model-card-candidates.ts'

/** Resolved cards by model id. `null` means "asked, and there is no card". */
const resolved = new Map<string, ModelCardCandidate | null>()
const inFlight = new Map<string, Promise<boolean>>()

/**
 * The card for a model id, or null when none resolved or none is known yet.
 * Synchronous by contract — tooltip builders call it while rendering.
 */
export function resolvedModelCard(id: string): ModelCardCandidate | null {
  return resolved.get(id) ?? null
}

/** True once an answer (card or "none") has been recorded for this id. */
export function hasResolvedModelCard(id: string): boolean {
  return resolved.has(id)
}

/** Record an answer. Used by the fetch path, and by tests to seed state. */
export function setResolvedModelCard(id: string, card: ModelCardCandidate | null): void {
  resolved.set(id, card)
}

/** Drop everything. Tests only. */
export function clearResolvedModelCards(): void {
  resolved.clear()
  inFlight.clear()
}

type ModelCardApi = Pick<ApiClient['modelCards'], 'resolve'>

/**
 * Resolve any of `ids` not already known, joining work already in flight.
 * Resolves to true when at least one requested answer lands after this call,
 * so every interested caller can repaint when it matters.
 * Never rejects: an unavailable bridge or a failed call means "no cards yet",
 * and the ids stay unresolved so a later call can retry.
 */
export async function requestModelCards(
  ids: readonly string[],
  api: ModelCardApi | undefined,
): Promise<boolean> {
  if (!api) return false
  const requested = [...new Set(ids)].filter((id) => !resolved.has(id))
  const waiting = requested.flatMap((id) => {
    const pending = inFlight.get(id)
    return pending ? [pending] : []
  })
  const missing = requested.filter((id) => !inFlight.has(id))

  if (missing.length > 0) {
    const batch = (async (): Promise<Set<string>> => {
      try {
        const answers = await api.resolve(missing)
        const landed = new Set<string>()
        for (const id of missing) {
          // An id the main process omitted is still unanswered, not "no card" —
          // leaving it unresolved keeps a later retry possible.
          if (!Object.prototype.hasOwnProperty.call(answers, id)) continue
          resolved.set(id, answers[id] ?? null)
          landed.add(id)
        }
        return landed
      } catch {
        return new Set<string>()
      }
    })()

    for (const id of missing) {
      const pending = batch.then((landed) => landed.has(id))
      inFlight.set(id, pending)
      waiting.push(pending)
      void pending.then(() => {
        if (inFlight.get(id) === pending) inFlight.delete(id)
      })
    }
  }

  if (waiting.length === 0) return false
  return (await Promise.all(waiting)).some(Boolean)
}
