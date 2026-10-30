import { mkdir, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { threadDirectoryPath } from '../thread-store.ts'
import { claudeCredentialsPath } from '../plan-usage-bridge.ts'

/**
 * Directory holding every ACP agent's thread-scoped config/home dirs, sibling
 * to `events.jsonl`.
 *
 * Untouched by `writeThread`/`readThread`, which only manage `CONTENT_DIRS`
 * (`messages/`, `blobs/`, `subagents/`) — see `acp-wire-trace.ts` for the same
 * root-level-sidecar pattern.
 */
export const ACP_AGENT_CONFIG_DIR_NAME = 'acp-agent-config'

/**
 * Thread- and agent-scoped directory to point an ACP agent's own home/config
 * env var at (e.g. Claude Code's `CLAUDE_CONFIG_DIR`), instead of letting it
 * default to the real `$HOME/.claude` — which carries the user's personal
 * synced skills, plugins, and MCP server configs into whatever unrelated
 * coding thread happens to spawn it.
 */
export function acpAgentConfigDir(projectId: string, threadId: string, agentId: string): string {
  return join(threadDirectoryPath(projectId, threadId), ACP_AGENT_CONFIG_DIR_NAME, agentId)
}

/** {@link acpAgentConfigDir}, created first so the agent's first write never races a missing directory. */
export async function ensureAcpAgentConfigDir(
  projectId: string,
  threadId: string,
  agentId: string,
): Promise<string> {
  const dir = acpAgentConfigDir(projectId, threadId, agentId)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * `claude`'s OAuth credentials file sits directly under its config dir —
 * `CLAUDE_CONFIG_DIR` *replaces* `~/.claude` rather than nesting inside it, so
 * pointing it at an empty per-thread directory would otherwise sign every
 * thread out on Linux/Windows, where that file (not the macOS Keychain) is
 * the only place a saved login lives (see `plan-usage-bridge.ts`). A symlink
 * keeps just this one file live from the account's real credentials while
 * everything else in the scoped directory — skills, plugins, settings,
 * project history — stays isolated. `EEXIST` means a prior turn on this same
 * thread already linked it; anything else is a best-effort failure, logged
 * once rather than failing the turn over it.
 */
async function linkClaudeCredentials(configDir: string, home: string): Promise<void> {
  if (process.platform === 'darwin') return
  try {
    await symlink(claudeCredentialsPath(home), join(configDir, '.credentials.json'))
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') return
    console.warn(`[acp-agent-config-dir] could not link Claude credentials into ${configDir}:`, err)
  }
}

/** {@link ensureAcpAgentConfigDir}, additionally keeping Claude's own login live (see {@link linkClaudeCredentials}). */
export async function ensureClaudeAcpConfigDir(
  projectId: string,
  threadId: string,
  agentId: string,
  home: string = homedir(),
): Promise<string> {
  const dir = await ensureAcpAgentConfigDir(projectId, threadId, agentId)
  await linkClaudeCredentials(dir, home)
  return dir
}
