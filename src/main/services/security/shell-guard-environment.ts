/**
 * Binds `@copse/shell-guard` to this app's filesystem facts. Imported for its
 * side effect by every app-side re-export of a shell-guard module, so any path
 * into the classifier from app code sees the same two roots the sandbox does:
 *
 * - the chat store (`copseWorkspaceDir`) the seatbelt overlay mounts read-only
 *   (#644), so a read of a past thread is contained rather than an escape;
 * - the scratch directories configured ACP agents declare (#481), which the
 *   seatbelt allow-lists and the classifier must therefore not flag.
 *
 * The classifier and the seatbelt must agree, or a command stops prompting and
 * then fails EPERM instead; keeping both bindings here, next to each other, is
 * what makes that agreement inspectable.
 */
import { configureShellScopeEnvironment } from '@copse/shell-guard/shell-scope.ts'
import { agentScratchMatcher } from '../../project-sandbox/agent-scratch-roots.ts'
import { copseWorkspaceDir } from '../storage/copse-paths.ts'

configureShellScopeEnvironment({
  containedReadRoot: () => copseWorkspaceDir(),
  sanctionedScratchMatcher: agentScratchMatcher,
})
