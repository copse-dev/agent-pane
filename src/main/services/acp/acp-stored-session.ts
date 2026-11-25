import { stat } from 'node:fs/promises'
import { canonicalAcpAgentId } from '@shared/acp-known-agents.ts'
import {
  clearAcpSessionBinding,
  loadAcpSessionBinding,
  saveAcpSessionBinding,
  type AcpSessionBinding,
} from '../thread-store.ts'
import { acpAgentConfigDir } from './acp-agent-config-dir.ts'
import type { AcpStoredSession } from './acp-session-pool.ts'
import type { AcpTranscriptCheckpoint } from './acp-transcript-checkpoint.ts'

/**
 * An imported Claude Code session continues in the thread's own copy of the
 * session file, under the thread's scoped `CLAUDE_CONFIG_DIR`. A turn whose
 * agent runs unscoped would find the user's original instead and write to it,
 * so it does not take the link.
 */
function continuesInThreadCopy(
  binding: AcpSessionBinding,
  projectId: string,
  threadId: string,
  agentId: string,
  claudeConfigDir: string | undefined,
): boolean {
  if (binding.createdBy !== 'external') return true
  if (canonicalAcpAgentId(agentId) !== 'claude-acp') return true
  return claudeConfigDir === acpAgentConfigDir(projectId, threadId, agentId)
}

/**
 * Slack for the agent's own writes landing after Copse recorded the file's
 * time: a rollout flushed a moment after the turn ended is not the CLI.
 */
const SHARED_FILE_SLACK_MS = 10_000

async function fileModifiedAt(path: string): Promise<number | null> {
  return stat(path).then(
    (info) => info.mtimeMs,
    () => null,
  )
}

/**
 * Whether a session file shared with the CLI went on outside Copse since the
 * thread last used it. A file that is gone counts as unchanged: the agent
 * says so itself when it cannot resume.
 */
async function continuedOutsideCopse(binding: AcpSessionBinding): Promise<boolean> {
  const shared = binding.sharedSessionFile
  if (!shared) return false
  const modifiedAt = await fileModifiedAt(shared.path)
  return modifiedAt !== null && modifiedAt > shared.modifiedAt + SHARED_FILE_SLACK_MS
}

/**
 * A thread's `acp-session.json` link, for the pool to reattach the session it
 * names. Only a local link to this same agent counts: a different agent never
 * inherits another's session.
 */
export function threadAcpStoredSession(
  projectId: string,
  threadId: string,
  agentId: string,
  turn: { claudeConfigDir?: string | undefined } = {},
): AcpStoredSession {
  let loaded: AcpSessionBinding | null = null
  return {
    load: async (): ReturnType<AcpStoredSession['load']> => {
      const binding = await loadAcpSessionBinding(projectId, threadId)
      if (
        !binding ||
        binding.executionTarget.kind !== 'local' ||
        canonicalAcpAgentId(binding.agentId) !== canonicalAcpAgentId(agentId) ||
        !continuesInThreadCopy(binding, projectId, threadId, agentId, turn.claudeConfigDir)
      ) {
        return null
      }
      if (await continuedOutsideCopse(binding)) {
        // Resuming would bring back turns this thread never showed; the
        // transcript it does show is what the agent starts from instead.
        console.warn(
          `[acp] thread ${threadId}'s imported session went on outside Copse; starting from the thread's transcript instead`,
        )
        await clearAcpSessionBinding(projectId, threadId)
        return null
      }
      loaded = binding
      return {
        sessionId: binding.sessionId,
        cwd: binding.workspaceIdentity,
        ...(binding.transcriptCheckpoint
          ? { transcriptCheckpoint: binding.transcriptCheckpoint }
          : {}),
      }
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

/**
 * Record, beside a thread's saved session link, how much of its history the
 * session now holds, so the turn after a relaunch sends only what is new.
 * A thread with no link for this agent is left alone.
 */
export async function recordStoredSessionCheckpoint(
  projectId: string,
  threadId: string,
  agentId: string,
  checkpoint: AcpTranscriptCheckpoint,
): Promise<void> {
  const binding = await loadAcpSessionBinding(projectId, threadId)
  if (!binding || canonicalAcpAgentId(binding.agentId) !== canonicalAcpAgentId(agentId)) return
  const shared = binding.sharedSessionFile
  const modifiedAt = shared ? await fileModifiedAt(shared.path) : null
  await saveAcpSessionBinding(projectId, threadId, {
    ...binding,
    transcriptCheckpoint: checkpoint,
    ...(shared && modifiedAt !== null
      ? { sharedSessionFile: { ...shared, modifiedAt: Math.max(shared.modifiedAt, modifiedAt) } }
      : {}),
  })
}
