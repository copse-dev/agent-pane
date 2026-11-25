import { getAcpAgent } from '../acp/acp-agent-registry.ts'
import { acpAgentConfigDir } from '../acp/acp-agent-config-dir.ts'
import { createThread, loadProjectThreadMetas, saveAcpSessionBinding } from '../thread-store.ts'
import { getLocalProjectRoot } from '../workspace.ts'
import type { ExternalSessionImportDeps } from './external-session-import.ts'

/** The import service wired to the real thread store, settings and agents. */
export function externalSessionImportDeps(): ExternalSessionImportDeps {
  return {
    projectRoot: getLocalProjectRoot,
    loadThreadMetas: (projectId) => loadProjectThreadMetas(projectId),
    createThread,
    agentEnabled: (agentId) => getAcpAgent(agentId) !== null,
    claudeThreadConfigDir: acpAgentConfigDir,
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
      }),
  }
}
