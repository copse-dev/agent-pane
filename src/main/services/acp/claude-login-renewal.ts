import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { parseClaudeOAuthCredential } from '@copse/plan-usage'
import type { AcpAgentConfig, AcpAgentSandboxConfig } from '@shared/types/acp.ts'
import { readClaudeKeychainCredentialsJson } from '../plan-usage-bridge.ts'
import { envForRendererChildProcess } from '../exec/child-process-env.ts'
import { findInstalledNpmPackage } from './acp-adapter-version.ts'
import { resolveOnPath } from './acp-detect.ts'

/**
 * Renewing a sandboxed Claude agent's login outside the sandbox.
 *
 * Copse's macOS sandbox lets a Claude agent read its login from the Keychain
 * but not write it (`allowMacOsKeychain` is a read grant: seatbelt can only
 * scope the whole `login.keychain-db`, and a write grant would let the agent
 * delete every saved password). Claude Code 2.1.33x proves the Keychain takes a
 * write before it spends the refresh token, so once the access token expires,
 * every sandboxed turn fails with "Failed to refresh OAuth token: can't save to
 * the Keychain" until something outside the sandbox renews it.
 *
 * Copse must never exchange the refresh token itself (#3215: refresh tokens
 * rotate, and a second owner revokes the one Claude holds). So the renewal is
 * Claude Code's own: Copse runs the agent's bundled CLI once, unsandboxed, for
 * a one-line print-mode request. Claude refreshes the expired token before that
 * request, under its own credentials lock, and saves it to the Keychain, where
 * the sandboxed agent reads it within 30 seconds (its Keychain cache).
 *
 * The run is as bare as print mode allows while still reading the Keychain: an
 * empty working directory, a throwaway `CLAUDE_CONFIG_DIR` (with an empty
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR`, so the login, its lock and its Keychain
 * item stay the account defaults), no settings sources, no tools and no MCP
 * servers. `--bare` is not usable: it skips Keychain reads.
 */

/** Claude's own renewal window: it refreshes a token within 5 minutes of expiry. */
export const CLAUDE_RENEWAL_WINDOW_MS = 5 * 60 * 1000

/** Long enough for CLI start-up, the refresh grant and one short model reply. */
const RENEWAL_TIMEOUT_MS = 60_000

/** The npm package whose adapter forwards `--cli …` to its bundled Claude CLI. */
const CLAUDE_AGENT_ACP_PACKAGE = '@agentclientprotocol/claude-agent-acp'

/**
 * Agent env that already chooses a credential or a CLI the Keychain renewal
 * cannot speak for: an API key or long-lived token needs no renewal, and a
 * relocated config dir or CLI keeps its login somewhere else.
 */
const OWN_CREDENTIAL_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_EXECUTABLE',
] as const

/** The print-mode request that makes Claude renew its token first. */
export const CLAUDE_RENEWAL_CLI_ARGS: readonly string[] = [
  '--cli',
  '-p',
  'Reply with OK.',
  '--model',
  'haiku',
  '--tools',
  '',
  '--strict-mcp-config',
  '--setting-sources',
  '',
  '--no-session-persistence',
  '--output-format',
  'json',
]

/** What a renewal needs to know about the turn's agent and confinement. */
export interface ClaudeLoginRenewalInput {
  agent: Pick<AcpAgentConfig, 'id' | 'command' | 'args' | 'env'>
  sandbox: AcpAgentSandboxConfig | undefined
  /** The agent spawns under Copse's seatbelt on this machine (not remote). */
  localSandboxed: boolean
  /** Paths the sandboxed agent can write: its workspace and Copse's state dirs. */
  writableRoots: readonly string[]
}

/** A Claude agent whose login a renewal outside the sandbox can serve. */
export interface ClaudeLoginRenewalTarget {
  /** The adapter binary, resolved on the agent's own PATH. */
  binary: string
  args: readonly string[]
}

export interface ClaudeLoginRenewalDeps {
  platform: NodeJS.Platform
  resolveBinary: (command: string, env: NodeJS.ProcessEnv) => Promise<string | null>
  findAdapterDir: (binary: string) => Promise<string | null>
  readKeychainCredentials: () => Promise<string | null>
  run: (
    binary: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  ) => Promise<boolean>
  now: () => number
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => path)
}

/**
 * The cheap half of {@link claudeLoginRenewalTarget}: macOS, a local sandboxed
 * agent with the Keychain read grant, and no credential of its own in its env.
 */
function claudeLoginRenewalEligible(
  input: ClaudeLoginRenewalInput,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== 'darwin') return false
  if (!input.localSandboxed || input.sandbox?.allowMacOsKeychain !== true) return false
  const env = input.agent.env ?? {}
  return !OWN_CREDENTIAL_ENV.some((name) => Object.hasOwn(env, name))
}

/**
 * The adapter to run for a renewal, or `null` when this turn's agent is not one
 * it can serve: not macOS, not a sandboxed local Claude agent reading the
 * Keychain, an agent env with its own credential, or an adapter without
 * `--cli`. Also `null` when the adapter lives somewhere the sandboxed agent can
 * write, since running a file the agent could have replaced outside the
 * sandbox would be an escape.
 */
export async function claudeLoginRenewalTarget(
  input: ClaudeLoginRenewalInput,
  deps: Pick<ClaudeLoginRenewalDeps, 'platform' | 'resolveBinary' | 'findAdapterDir'>,
): Promise<ClaudeLoginRenewalTarget | null> {
  const sandbox = input.sandbox
  if (!sandbox || !claudeLoginRenewalEligible(input, deps.platform)) return null
  const env = input.agent.env ?? {}
  const binary = isAbsolute(input.agent.command)
    ? input.agent.command
    : await deps.resolveBinary(input.agent.command, { ...process.env, ...env })
  if (!binary) return null
  const adapterDir = await deps.findAdapterDir(binary)
  if (!adapterDir) return null
  const home = homedir()
  const roots = [
    ...input.writableRoots,
    ...(sandbox.homeDirs ?? []).map((rel) => join(home, rel)),
    tmpdir(),
    '/tmp',
  ]
  // Both spellings of each side: a symlinked root (macOS's /tmp, /var) or a
  // link to the adapter must not slip past the comparison.
  const writable = [...roots, ...(await Promise.all(roots.map(canonical)))]
  const runs = [
    binary,
    adapterDir,
    ...(await Promise.all([canonical(binary), canonical(adapterDir)])),
  ]
  if (runs.some((path) => writable.some((root) => isWithin(path, root)))) return null
  return { binary, args: [...(input.agent.args ?? []), ...CLAUDE_RENEWAL_CLI_ARGS] }
}

/** Claude would renew this token now: it has expired or is inside its window. */
export function claudeTokenNeedsRenewal(expiresAt: number | null, now: number): boolean {
  return expiresAt !== null && now + CLAUDE_RENEWAL_WINDOW_MS >= expiresAt
}

/**
 * The expiry of the login a sandboxed Claude agent reads, from the Keychain
 * item, or `null` when there is none to read or it carries no expiry.
 */
async function keychainTokenExpiry(
  deps: Pick<ClaudeLoginRenewalDeps, 'readKeychainCredentials'>,
): Promise<number | null> {
  const raw = await deps.readKeychainCredentials()
  return raw === null ? null : (parseClaudeOAuthCredential(raw)?.expiresAt ?? null)
}

let inFlight: Promise<boolean> | null = null

/**
 * Run Claude's own renewal outside the sandbox. One at a time: concurrent
 * turns share the run in flight, and Claude's credentials lock serialises it
 * against the agents themselves. Resolves `true` only when the run succeeded.
 */
export function renewClaudeLogin(
  target: ClaudeLoginRenewalTarget,
  deps: Pick<ClaudeLoginRenewalDeps, 'run'>,
): Promise<boolean> {
  inFlight ??= runRenewalOnce(target, deps).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runRenewalOnce(
  target: ClaudeLoginRenewalTarget,
  deps: Pick<ClaudeLoginRenewalDeps, 'run'>,
): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'copse-claude-renewal-'))
  try {
    const cwd = join(dir, 'cwd')
    const configDir = join(dir, 'config')
    await Promise.all([mkdir(cwd), mkdir(configDir)])
    return await deps.run(target.binary, target.args, {
      cwd,
      env: {
        ...envForRendererChildProcess(process.env),
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
      },
      timeoutMs: RENEWAL_TIMEOUT_MS,
    })
  } catch {
    return false
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Before a sandboxed Claude turn: renew the login outside the sandbox when the
 * token is about to be refused inside it. Returns whether a renewal ran and
 * succeeded; `false` covers "not needed" as well as failures, which leave the
 * turn to report them.
 */
export async function renewClaudeLoginIfDue(
  input: ClaudeLoginRenewalInput,
  deps: ClaudeLoginRenewalDeps = defaultClaudeLoginRenewalDeps(),
): Promise<boolean> {
  // Cheapest first: this runs before every sandboxed Claude turn.
  if (!claudeLoginRenewalEligible(input, deps.platform)) return false
  if (!claudeTokenNeedsRenewal(await keychainTokenExpiry(deps), deps.now())) return false
  const target = await claudeLoginRenewalTarget(input, deps)
  return target ? renewClaudeLogin(target, deps) : false
}

/**
 * After a sandboxed Claude turn failed because the Keychain refused the save:
 * renew outside the sandbox so the next attempt reads a fresh token.
 */
export async function renewClaudeLoginAfterRefusal(
  input: ClaudeLoginRenewalInput,
  deps: ClaudeLoginRenewalDeps = defaultClaudeLoginRenewalDeps(),
): Promise<boolean> {
  const target = await claudeLoginRenewalTarget(input, deps)
  return target ? renewClaudeLogin(target, deps) : false
}

function runRenewal(
  binary: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(
      binary,
      [...args],
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, encoding: 'utf8' },
      (error) => {
        resolve(error === null)
      },
    )
    child.stdin?.end()
  })
}

export function defaultClaudeLoginRenewalDeps(): ClaudeLoginRenewalDeps {
  return {
    platform: process.platform,
    resolveBinary: resolveOnPath,
    findAdapterDir: async (binary) =>
      (await findInstalledNpmPackage(binary, CLAUDE_AGENT_ACP_PACKAGE))?.dir ?? null,
    readKeychainCredentials: readClaudeKeychainCredentialsJson,
    run: runRenewal,
    now: Date.now,
  }
}
