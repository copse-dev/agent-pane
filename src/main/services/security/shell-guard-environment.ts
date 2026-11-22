/**
 * Binds `@copse/shell-guard` to this app's filesystem facts. Imported for its
 * side effect by every app-side re-export of a shell-guard module, so any path
 * into the classifier from app code sees the same roots the sandbox does:
 *
 * - the chat store (`copseWorkspaceDir`) the seatbelt overlay mounts read-only
 *   (#644), so a read of a past thread is contained rather than an escape;
 * - the read-only roots granted to the active thread — the directories of the
 *   skills it invoked (`thread-read-roots.ts`) — which the overlay adds to
 *   `allowRead` for that thread's commands;
 * - the active thread's workspace scratch and configured ACP scratch (#481),
 *   which the sandbox allows and the classifier must therefore not flag;
 * - actual filesystem paths for supported literal symbolic-link commands.
 *
 * The classifier and the seatbelt must agree, or a command stops prompting and
 * then fails EPERM instead; keeping the bindings here, next to each
 * other, is what makes that agreement inspectable.
 */
import { configureShellScopeEnvironment } from '@copse/shell-guard/shell-scope.ts'
import { agentScratchMatcher } from '../../project-sandbox/agent-scratch-roots.ts'
import { ensureWorkspaceTmpDir } from '../../project-sandbox/workspace-tmp.ts'
import { sep } from 'node:path'
import { isWorkspaceSymlink, resolveShellPath } from './shell-path-facts.ts'
import { copseWorkspaceDir } from '../storage/copse-paths.ts'
import { getChatStoreRootSync } from '../workspace.ts'
import { activeThreadReadRootPaths } from './thread-read-roots.ts'
import { threadChatReadRoots } from './thread-access.ts'

configureShellScopeEnvironment({
  containedReadRoots: () => {
    const roots = new Set(
      [copseWorkspaceDir(), getChatStoreRootSync()].flatMap((root) => {
        return root ? threadChatReadRoots(root) : []
      }),
    )
    return [...roots, ...activeThreadReadRootPaths()]
  },
  sanctionedScratchMatcher: () => {
    const agentScratch = agentScratchMatcher()
    let root: string | null = null
    try {
      root = ensureWorkspaceTmpDir()
    } catch {
      // No authoritative scratch grant when its directory cannot be established.
    }
    return (path: string): boolean => {
      if (/[$`*?[\]{}\\]/.test(path)) return false
      const canonical = resolveShellPath(path)?.path
      if (!canonical) return false
      if (root !== null && (canonical === root || canonical.startsWith(`${root}${sep}`)))
        return true
      return Boolean(agentScratch?.(path) && agentScratch(canonical))
    }
  },
  isContainedSymlink: isWorkspaceSymlink,
})
