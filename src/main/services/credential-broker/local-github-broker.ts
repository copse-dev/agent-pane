/**
 * The main-process GitHub broker for local executions (execution-runtime-security
 * R2). Binds each grant to the current turn's project, thread and principal,
 * attaches the user's GitHub login host-side and records every grant, use and
 * refusal on that thread's spine.
 */
import { tmpdir } from 'node:os'
import type { LocalGitHubBroker } from '../../project-sandbox/local-runtime.ts'
import { resolveGitHubApiToken } from '../github/backend/github-token.ts'
import { recordDecision } from '../security/decision-log-store.ts'
import { resolveExecutionPrincipal } from '../execution-runtime/principal.ts'
import { currentThreadExecutionContext } from '../thread-execution-context-store.ts'
import { createGitHubCredentialBroker, fetchUpstream } from './github-broker.ts'

export function createLocalGitHubBroker(): LocalGitHubBroker {
  const broker = createGitHubCredentialBroker({
    resolveToken: resolveGitHubApiToken,
    upstream: fetchUpstream,
    record: recordDecision,
    now: Date.now,
    // Short on purpose: a unix socket path is capped near 104 bytes on macOS.
    stateDir: tmpdir,
  })
  return async ({ profile, readOnly }) => {
    const context = currentThreadExecutionContext()
    if (!context) return null
    try {
      return await broker.issue({
        principal: resolveExecutionPrincipal(context),
        projectId: context.projectId,
        threadId: context.threadId,
        profile,
        readOnly,
      })
    } catch (error) {
      // The child still loses its raw tokens; it just gets no grant.
      console.warn('[github-broker] could not issue a grant', error)
      return null
    }
  }
}
