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
 * - the scratch directories configured ACP agents declare (#481), which the
 *   seatbelt allow-lists and the classifier must therefore not flag.
 *
 * The classifier and the seatbelt must agree, or a command stops prompting and
 * then fails EPERM instead; keeping all three bindings here, next to each
 * other, is what makes that agreement inspectable.
 */
import { configureShellScopeEnvironment } from '@copse/shell-guard/shell-scope.ts'
import { agentScratchMatcher } from '../../project-sandbox/agent-scratch-roots.ts'
import { copseWorkspaceDir } from '../storage/copse-paths.ts'
import { activeThreadReadRootPaths } from './thread-read-roots.ts'

configureShellScopeEnvironment({
  containedReadRoots: () => [copseWorkspaceDir(), ...activeThreadReadRootPaths()],
  sanctionedScratchMatcher: agentScratchMatcher,
})
