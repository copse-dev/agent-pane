import { canonicalAcpAgentId } from '@shared/acp-known-agents.ts'
import {
  clearAcpSessionBinding,
  loadAcpSessionBinding,
  saveAcpSessionBinding,
  type AcpSessionBinding,
} from '../thread-store.ts'
import type { AcpStoredSession } from './acp-session-pool.ts'

/**
 * A thread's `acp-session.json` link, for the pool to reattach the session it
 * names. Only a local link to this same agent counts: a different agent never
 * inherits another's session.
 */
export function threadAcpStoredSession(
  projectId: string,
  threadId: string,
  agentId: string,
): AcpStoredSession {
  let loaded: AcpSessionBinding | null = null
  return {
    load: async (): Promise<{ sessionId: string; cwd: string } | null> => {
      const binding = await loadAcpSessionBinding(projectId, threadId)
      if (
        !binding ||
        binding.executionTarget.kind !== 'local' ||
        canonicalAcpAgentId(binding.agentId) !== canonicalAcpAgentId(agentId)
      ) {
        return null
      }
      loaded = binding
      return { sessionId: binding.sessionId, cwd: binding.workspaceIdentity }
    },
    keep: async (sessionId: string): Promise<void> => {
      if (!loaded) return
      await saveAcpSessionBinding(projectId, threadId, {
        ...loaded,
        sessionId,
        lastAttachedAt: Date.now(),
      })
    },
    drop: () => clearAcpSessionBinding(projectId, threadId),
  }
}
