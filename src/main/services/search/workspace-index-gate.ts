import { resolve } from 'node:path'
import type { IndexWorkMode } from './workspace-index-policy.ts'

/**
 * Per-root gate so semantic track cannot race ahead of file-index scale
 * evidence (#795). `startWorkspaceIndexing` sets `pending` before awaiting the
 * file index, then resolves to the policy decision.
 */

type GateMode = 'pending' | IndexWorkMode

interface RootGate {
  semantic: GateMode
  watch: GateMode
}

const gates = new Map<string, RootGate>()

function key(root: string): string {
  return resolve(root)
}

/** Mark a workspace as awaiting scale evidence before semantic/watch start. */
export function beginWorkspaceIndexGate(root: string): void {
  gates.set(key(root), { semantic: 'pending', watch: 'pending' })
}

/** Publish the policy decision for a workspace root. */
export function resolveWorkspaceIndexGate(
  root: string,
  modes: { semantic: IndexWorkMode; watch: IndexWorkMode },
): void {
  gates.set(key(root), { semantic: modes.semantic, watch: modes.watch })
}

export function clearWorkspaceIndexGate(root?: string): void {
  if (root === undefined) {
    gates.clear()
    return
  }
  gates.delete(key(root))
}

/**
 * Whether semantic ensure/update may start for this root.
 * Unknown roots (unit tests that call ensure directly) default to allowed.
 */
export function semanticIndexAllowed(root: string): boolean {
  const gate = gates.get(key(root))
  if (!gate) return true
  return gate.semantic === 'full'
}

/** True while file-index scale evidence is still being gathered. */
export function semanticIndexPending(root: string): boolean {
  const gate = gates.get(key(root))
  return gate?.semantic === 'pending'
}

export function watchIndexAllowed(root: string): boolean {
  const gate = gates.get(key(root))
  if (!gate) return true
  return gate.watch === 'full'
}
