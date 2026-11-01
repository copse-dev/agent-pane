import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { KNOWN_ACP_AGENTS } from '@shared/acp-known-agents.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { threadDirectoryPath } from '../thread-store.ts'
import {
  compareNpmVersions,
  findInstalledNpmPackage,
  parseNpmVersionTuple,
} from './acp-adapter-version.ts'
import { resolveAcpConfigDirEnvVar } from './acp-agent-registry.ts'
import { resolveOnPath } from './acp-detect.ts'
import type { AcpSshTarget } from './acp-ssh-transport.ts'

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
 * First Claude Code CLI whose secure storage honours
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR`. Bisected against the binaries
 * `@anthropic-ai/claude-agent-sdk` bundles: 2.1.143 does not read it, yet has
 * long derived its macOS Keychain item name from `CLAUDE_CONFIG_DIR`
 * (`Claude Code-credentials-<first 8 hex of sha256(dir)>`), so a CLI older
 * than this one cannot be scoped without signing it out.
 *
 * `@agentclientprotocol/claude-agent-acp` 0.37.0 is the first adapter whose
 * bundled SDK carries a new-enough CLI (2.1.146).
 */
export const CLAUDE_SECURESTORAGE_MIN_CLI_VERSION = '2.1.144'

/** npm packages that ship a Claude ACP adapter, from the catalog. */
const CLAUDE_ADAPTER_PACKAGES = KNOWN_ACP_AGENTS.flatMap((agent) =>
  agent.requiresClient === 'claude' && agent.installPackage ? [agent.installPackage] : [],
)

const CLAUDE_AGENT_SDK = '@anthropic-ai/claude-agent-sdk'

const claudeAgentSdkPackageSchema = z.object({
  name: z.literal(CLAUDE_AGENT_SDK),
  claudeCodeVersion: z.string().min(1).optional(),
})

/**
 * The CLI version the adapter installed at `adapterDir` runs: the
 * `claudeCodeVersion` of the Agent SDK Node would resolve from there (nested
 * under the adapter for npm, a sibling in a pnpm store). The adapter spawns
 * that SDK's platform binary unless `CLAUDE_CODE_EXECUTABLE` overrides it.
 */
async function bundledClaudeCodeVersion(adapterDir: string): Promise<string | null> {
  let dir = adapterDir
  for (let i = 0; i < 12; i += 1) {
    if (basename(dir) !== 'node_modules') {
      const manifest = join(dir, 'node_modules', CLAUDE_AGENT_SDK, 'package.json')
      const text = await readFile(manifest, 'utf8').catch(() => null)
      // The first SDK found is the one the adapter loads, readable or not.
      if (text !== null) {
        const sdk = safeJsonParse(text, decodeWithSchema(claudeAgentSdkPackageSchema))
        return sdk?.claudeCodeVersion ?? null
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Whether the Claude CLI this agent will run keeps the account's default
 * login under {@link scopedClaudeConfigEnv}. Anything Copse cannot read off
 * disk — a runner such as `npx`, a CLI swapped in through
 * `CLAUDE_CODE_EXECUTABLE`, an install without a declared CLI version — is
 * "no": an unscoped agent only inherits the user's personal setup, while a
 * wrongly scoped one is silently signed out.
 */
async function claudeCliKeepsDefaultLogin(agent: AcpAgentConfig): Promise<boolean> {
  // The adapter runs that CLI instead of its bundled one. Read it the way the
  // spawn composes env: the agent's own over Copse's.
  if ({ ...process.env, ...agent.env }['CLAUDE_CODE_EXECUTABLE']) return false
  const binary = isAbsolute(agent.command) ? agent.command : await resolveOnPath(agent.command)
  if (!binary) return false
  for (const packageName of CLAUDE_ADAPTER_PACKAGES) {
    const adapter = await findInstalledNpmPackage(binary, packageName)
    if (!adapter) continue
    const cli = await bundledClaudeCodeVersion(adapter.dir)
    return (
      cli !== null &&
      parseNpmVersionTuple(cli) !== null &&
      compareNpmVersions(cli, CLAUDE_SECURESTORAGE_MIN_CLI_VERSION) >= 0
    )
  }
  return false
}

/**
 * Thread-scoped config for a local Claude agent, or `undefined` to leave it on
 * its own default (`~/.claude`).
 *
 * `CLAUDE_CONFIG_DIR` alone would sign the agent out: Claude Code keys its
 * secure storage off that dir too — the macOS Keychain item name gains a hash
 * of it, and the Linux/Windows `.credentials.json` moves into it. An **empty**
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` tells the CLI to keep its credentials (and
 * their refresh lock) at the defaults — the very login Settings shows as
 * signed in — while everything else lives in the thread's own directory.
 */
async function scopedClaudeConfigEnv(input: {
  agent: AcpAgentConfig
  projectId: string | undefined
  threadId: string
  sshTarget: AcpSshTarget | null
}): Promise<Record<string, string> | undefined> {
  const { agent, projectId } = input
  // Claude is the only agent whose login is known to survive a scoped dir;
  // another agent's config-dir var needs that answer before it is scoped.
  if (resolveAcpConfigDirEnvVar(agent) !== 'CLAUDE_CONFIG_DIR') return undefined
  // A path on this machine means nothing on an SSH host, and in `env` it would
  // also have the forwarding gate ask to send it there.
  if (input.sshTarget) return undefined
  // A dir chosen in Settings wins, with the CLI's own semantics — login included.
  if (agent.env && Object.hasOwn(agent.env, 'CLAUDE_CONFIG_DIR')) return undefined
  if (!projectId) return undefined
  if (!(await claudeCliKeepsDefaultLogin(agent))) return undefined
  try {
    return {
      CLAUDE_CONFIG_DIR: await ensureAcpAgentConfigDir(projectId, input.threadId, agent.id),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    }
  } catch (err) {
    console.warn(
      '[acp-agent-config-dir] could not scope CLAUDE_CONFIG_DIR to this thread; the agent will use its own default:',
      err,
    )
    return undefined
  }
}

/**
 * The `env` a turn spawns its ACP agent with: the agent's own configured env
 * (Settings → Coding agents) over the thread-scoped config default, when one
 * applies (see {@link scopedClaudeConfigEnv}). `undefined` when there is
 * neither.
 */
export async function resolveAcpAgentTurnEnv(input: {
  agent: AcpAgentConfig
  projectId: string | undefined
  threadId: string
  sshTarget: AcpSshTarget | null
}): Promise<Record<string, string> | undefined> {
  const scoped = await scopedClaudeConfigEnv(input)
  const configured = input.agent.env
  return scoped || configured ? { ...scoped, ...configured } : undefined
}
