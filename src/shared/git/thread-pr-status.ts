import type { Thread } from '../types/thread.ts'
import {
  extractGithubPrUrls,
  githubPrKey,
  parseGithubPrUrl,
  type GithubPrRef,
} from './github-pr-url.ts'

/** Lifecycle bucket for a GitHub PR, independent of backend casing quirks. */
export type PrLifecycleState = 'open' | 'merged' | 'closed' | 'unknown'

/**
 * Compact rollup shown on a sidebar thread row: unfinished work (open) wins over
 * terminal states so a mixed set still surfaces "N open".
 */
export type ThreadPrRollup =
  | { kind: 'open'; openCount: number; totalCount: number; primaryNumber?: number }
  | { kind: 'merged'; totalCount: number }
  | { kind: 'closed'; totalCount: number }

/** Collect unique GitHub PR refs linked to a thread (chat text + durable agent link). */
export function collectThreadPrRefs(
  thread: Pick<Thread, 'messages' | 'remoteAgentLink'>,
): GithubPrRef[] {
  const seen = new Set<string>()
  const refs: GithubPrRef[] = []

  const push = (ref: GithubPrRef): void => {
    const key = githubPrKey(ref)
    if (seen.has(key)) return
    seen.add(key)
    refs.push(ref)
  }

  for (const message of thread.messages) {
    for (const ref of extractGithubPrUrls(message.content)) push(ref)
  }

  const linkedUrl = thread.remoteAgentLink?.prUrl
  if (linkedUrl) {
    const parsed = parseGithubPrUrl(linkedUrl)
    if (parsed) push(parsed)
  }

  return refs
}

/**
 * Normalize backend PR `state` strings (`OPEN` / `open` / `MERGED` / …) into a
 * lifecycle bucket. REST often reports merged PRs as `CLOSED` with `merged: true`
 * — pass that flag when known.
 */
export function normalizePrLifecycleState(state: string, merged = false): PrLifecycleState {
  const normalized = state.trim().toUpperCase()
  if (normalized === 'OPEN') return 'open'
  if (normalized === 'MERGED' || merged) return 'merged'
  if (normalized === 'CLOSED') return 'closed'
  return 'unknown'
}

/** Collapse per-PR lifecycle states into the sidebar rollup (or null when empty/unknown). */
export function summarizeThreadPrStatus(
  states: readonly PrLifecycleState[],
  refs: readonly Pick<GithubPrRef, 'number'>[] = [],
): ThreadPrRollup | null {
  if (states.length === 0) return null

  let openCount = 0
  let mergedCount = 0
  let knownCount = 0
  for (const state of states) {
    if (state === 'unknown') continue
    knownCount += 1
    if (state === 'open') openCount += 1
    else if (state === 'merged') mergedCount += 1
  }
  if (knownCount === 0) return null

  if (openCount > 0) {
    const rollup: ThreadPrRollup = {
      kind: 'open',
      openCount,
      totalCount: knownCount,
    }
    if (openCount === 1 && knownCount === 1 && refs[0]) {
      return { ...rollup, primaryNumber: refs[0].number }
    }
    return rollup
  }

  if (mergedCount === knownCount) {
    return { kind: 'merged', totalCount: knownCount }
  }

  return { kind: 'closed', totalCount: knownCount }
}

/** Short label for the projects-pane chip. */
export function formatThreadPrStatus(rollup: ThreadPrRollup): string {
  if (rollup.kind === 'open') {
    if (rollup.primaryNumber != null) return `#${String(rollup.primaryNumber)}`
    return rollup.openCount === 1 ? '1 open' : `${String(rollup.openCount)} open`
  }
  if (rollup.kind === 'merged') {
    return rollup.totalCount === 1 ? 'merged' : 'all merged'
  }
  return rollup.totalCount === 1 ? 'closed' : 'all closed'
}

/** Accessible description for the chip. */
export function describeThreadPrStatus(rollup: ThreadPrRollup): string {
  if (rollup.kind === 'open') {
    if (rollup.primaryNumber != null) {
      return `Pull request #${String(rollup.primaryNumber)} is open`
    }
    return rollup.openCount === 1
      ? '1 pull request is open'
      : `${String(rollup.openCount)} pull requests are open`
  }
  if (rollup.kind === 'merged') {
    return rollup.totalCount === 1
      ? 'Pull request is merged'
      : 'All linked pull requests are merged'
  }
  return rollup.totalCount === 1 ? 'Pull request is closed' : 'All linked pull requests are closed'
}
