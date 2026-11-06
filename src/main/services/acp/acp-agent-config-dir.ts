import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
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

/** Whether `dir` is one of this thread's {@link acpAgentConfigDir}s: Copse's, not the user's. */
export function isThreadAcpAgentConfigDir(
  dir: string,
  projectId: string,
  threadId: string,
): boolean {
  return dirname(dir) === join(threadDirectoryPath(projectId, threadId), ACP_AGENT_CONFIG_DIR_NAME)
}

/**
 * Claude Code's negative cache of MCP servers, in its config dir. Since CLI
 * 2.1.278 it records a server that failed to connect (CONNECTION_CLOSED, not
 * only a 401) by **name**, and for 15 minutes every CLI started on that dir
 * skips the server ("Skipping connection (recent failure cached…)") without
 * trying the URL it was handed.
 */
export const CLAUDE_MCP_FAILURE_CACHE_FILE = 'mcp-needs-auth-cache.json'

const claudeMcpFailureCacheSchema = z.record(z.string(), z.unknown())

/** Far past a real cache, which holds a name and a timestamp per server. */
const CLAUDE_MCP_FAILURE_CACHE_MAX_BYTES = 256 * 1024

const missingFileErrorSchema = z.object({ code: z.literal('ENOENT') })

function leaveClaudeMcpFailureCache(path: string, reason: string): null {
  console.warn(`[acp-agent-config-dir] left ${path} as it is: ${reason}`)
  return null
}

/**
 * The text of the failure cache at `path`, or `null` when there is nothing to
 * clear. The config dir is the sandboxed agent's writable state dir, read here
 * by the unsandboxed main process under the thread's session lock, so only a
 * regular file of a cache's size is read: never through a link the agent
 * planted, never from a FIFO that would wait for a writer, never unbounded.
 */
async function readClaudeMcpFailureCache(path: string): Promise<string | null> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((err: unknown) => {
    if (!missingFileErrorSchema.safeParse(err).success) {
      leaveClaudeMcpFailureCache(path, err instanceof Error ? err.message : String(err))
    }
    return null
  })
  if (!file) return null
  try {
    const stat = await file.stat()
    if (!stat.isFile()) return leaveClaudeMcpFailureCache(path, 'not a regular file')
    if (stat.size > CLAUDE_MCP_FAILURE_CACHE_MAX_BYTES) {
      return leaveClaudeMcpFailureCache(
        path,
        `larger than ${String(CLAUDE_MCP_FAILURE_CACHE_MAX_BYTES)} bytes`,
      )
    }
    const buffer = Buffer.alloc(stat.size + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== stat.size) return leaveClaudeMcpFailureCache(path, 'changed while being read')
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch (err) {
    return leaveClaudeMcpFailureCache(path, err instanceof Error ? err.message : String(err))
  } finally {
    await file.close()
  }
}

/**
 * Drop `serverName`'s entry from {@link CLAUDE_MCP_FAILURE_CACHE_FILE} in
 * `configDir`, keeping every other server's. Returns whether one was dropped.
 *
 * Copse names its native-tool bridge the same on every process it spawns for a
 * thread, but each process gets a new bridge (new port, new token) that is
 * listening before the agent starts. A failure the cache holds was against an
 * earlier bridge, so honouring it hides a live bridge from the agent (#4142).
 * A missing cache, or anything there but a regular file of a cache's size, is
 * left as it is.
 */
export async function forgetClaudeMcpServerFailure(
  configDir: string,
  serverName: string,
): Promise<boolean> {
  const path = join(configDir, CLAUDE_MCP_FAILURE_CACHE_FILE)
  const text = await readClaudeMcpFailureCache(path)
  if (text === null) return false
  const cache = safeJsonParse(text, decodeWithSchema(claudeMcpFailureCacheSchema))
  if (!cache || !Object.hasOwn(cache, serverName)) return false
  const kept = Object.fromEntries(Object.entries(cache).filter(([name]) => name !== serverName))
  // Replace, never truncate in place: the CLI reads this file whole. The agent
  // can write this dir, so the staging name is unguessable and created only if
  // nothing is there (`wx` never opens through a planted link), and the rename
  // swaps the cache's directory entry rather than writing into what it was.
  const staging = `${path}.${randomBytes(16).toString('hex')}.tmp`
  try {
    await writeFile(staging, JSON.stringify(kept), { flag: 'wx', mode: 0o600 })
    await rename(staging, path)
  } catch (err) {
    await rm(staging, { force: true }).catch(() => undefined)
    throw err
  }
  return true
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
  // Env as `buildAcpAgentEnv` composes it for the spawn, the agent's own over
  // Copse's (whose scrub drops only secrets, never PATH or this override).
  const spawnEnv = { ...process.env, ...agent.env }
  // The adapter runs that CLI instead of its bundled one.
  if (spawnEnv['CLAUDE_CODE_EXECUTABLE']) return false
  // A bare command is found on the spawn env's PATH, so look there: a PATH set
  // in Settings can reach a different, older install than Copse's own would.
  const binary = isAbsolute(agent.command)
    ? agent.command
    : await resolveOnPath(agent.command, spawnEnv)
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
