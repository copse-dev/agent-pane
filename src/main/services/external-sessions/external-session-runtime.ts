import { getAcpAgent } from '../acp/acp-agent-registry.ts'
import { acpAgentConfigDir, localClaudeConfigIsScoped } from '../acp/acp-agent-config-dir.ts'
import { checkpointAcpHistory } from '../acp/acp-transcript-checkpoint.ts'
import {
  createThread,
  loadProjectThreadMetas,
  saveAcpSessionBinding,
  saveAgentHistory,
} from '../thread-store.ts'
import { getLocalProjectRoot } from '../workspace.ts'
import type { ExternalSessionImportDeps } from './external-session-import.ts'

/** The import service wired to the real thread store, settings and agents. */
export function externalSessionImportDeps(): ExternalSessionImportDeps {
  return {
    projectRoot: getLocalProjectRoot,
    loadThreadMetas: (projectId) => loadProjectThreadMetas(projectId),
    createThread,
    findAgent: async (agentId): ReturnType<ExternalSessionImportDeps['findAgent']> => {
      const agent = getAcpAgent(agentId)
      if (!agent) return null
      return { id: agent.id, sessionsStayInThread: await localClaudeConfigIsScoped(agent) }
    },
    claudeThreadConfigDir: acpAgentConfigDir,
    saveHistory: (projectId, threadId, history) => saveAgentHistory(projectId, threadId, history),
    saveBinding: (projectId, threadId, binding) =>
      saveAcpSessionBinding(projectId, threadId, {
        v: 1,
        agentId: binding.agentId,
        sessionId: binding.sessionId,
        protocolVersion: 1,
        executionTarget: { kind: 'local' },
        workspaceIdentity: binding.cwd,
        agentConfigGeneration: 0,
        createdBy: 'external',
        lastAttachedAt: Date.now(),
        transcriptCheckpoint: checkpointAcpHistory(binding.history),
        ...(binding.sharedFile ? { sharedSessionFile: binding.sharedFile } : {}),
      }),
  }
}
