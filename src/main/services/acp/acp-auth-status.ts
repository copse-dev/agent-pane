import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { buildAcpAgentEnv } from './acp-client.ts'
import { canonicalAcpAgentId, KNOWN_ACP_AGENTS } from '@shared/acp-known-agents.ts'
import type { AcpAgentConfig, AcpAuthState, AcpAuthStatus } from '@shared/types/acp.ts'
import { listAcpAgents } from './acp-agent-registry.ts'

const run = promisify(execFile)

/** What each check needs from the machine, injectable so tests need neither. */
export interface AcpAuthProbeDeps {
  /** Environment the agent would inherit, plus any `env` saved on its entry. */
  env: Readonly<Record<string, string | undefined>>
  fileExists: (path: string) => Promise<boolean>
  /** Run a CLI and return its stdout; rejects on a non-zero exit or timeout. */
  exec: (command: string, args: string[]) => Promise<string>
  home: string
  /** The launch command Copse would spawn for this agent (saved entry or catalog). */
  agent: { command: string; args: readonly string[] }
}

function hasEnv(deps: AcpAuthProbeDeps, ...names: string[]): boolean {
  return names.some((name) => (deps.env[name] ?? '').trim().length > 0)
}

function state(signedIn: boolean): AcpAuthState {
  return signedIn ? 'signed-in' : 'signed-out'
}

/** `codex login status` via `command` (plus any leading args); unknown on failure. */
async function codexLoginStatus(
  deps: AcpAuthProbeDeps,
  command: string,
  args: readonly string[],
): Promise<AcpAuthState> {
  try {
    const out = await deps.exec(command, [...args, 'login', 'status'])
    if (/not logged in/i.test(out)) return 'signed-out'
    if (/logged in using/i.test(out)) return 'signed-in'
    return 'unknown'
  } catch {
    // A missing CLI, timeout or execution failure cannot establish logout.
    // Credential-file absence is not proof either: the CLI owns its store.
    return 'unknown'
  }
}

/**
 * Whether the user is signed in to the CLI behind an ACP agent. Each agent keeps
 * its own login, so each check asks that agent's own tooling or credential file
 * (never Copse's provider keys, which are stripped from the agent's environment).
 * A check that cannot tell reports `unknown`, which the UI treats as "don't
 * claim anything" rather than as signed out.
 */
const CHECKS: Readonly<Record<string, (deps: AcpAuthProbeDeps) => Promise<AcpAuthState>>> = {
  'claude-acp': async (deps) => {
    if (hasEnv(deps, 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN')) return 'signed-in'
    try {
      const out = await deps.exec('claude', ['auth', 'status'])
      const parsed = safeJsonParse(out, decodeWithSchema(z.object({ loggedIn: z.boolean() })))
      if (parsed) return state(parsed.loggedIn)
      return 'unknown'
    } catch {
      // `claude auth status` exits non-zero when logged out, but a missing
      // binary or an old CLI without `auth` fails the same way.
      return 'unknown'
    }
  },
  'codex-acp': async (deps) => {
    if (hasEnv(deps, 'OPENAI_API_KEY', 'CODEX_API_KEY')) return 'signed-in'
    const standalone = await codexLoginStatus(deps, 'codex', [])
    if (standalone !== 'unknown') return standalone
    // The npm adapter bundles its own Codex CLI (honouring CODEX_PATH) and
    // exposes it as `codex-acp cli`, so an install with no `codex` on PATH is
    // still answered by the same CLI and credential store the agent runs on.
    return codexLoginStatus(deps, deps.agent.command, [...deps.agent.args, 'cli'])
  },
  gemini: async (deps) =>
    hasEnv(deps, 'GEMINI_API_KEY', 'GOOGLE_API_KEY')
      ? 'signed-in'
      : (await deps.fileExists(join(deps.home, '.gemini', 'oauth_creds.json')))
        ? 'unknown'
        : 'signed-out',
  cursor: async (deps) => {
    if (hasEnv(deps, 'CURSOR_API_KEY')) return 'signed-in'
    try {
      const out = await deps.exec('cursor-agent', ['status'])
      if (/not logged in/i.test(out)) return 'signed-out'
      return /logged in/i.test(out) ? 'signed-in' : 'unknown'
    } catch {
      return 'unknown'
    }
  },
}

export async function probeAcpAuth(agentId: string, deps: AcpAuthProbeDeps): Promise<AcpAuthState> {
  const check = Object.hasOwn(CHECKS, agentId) ? CHECKS[agentId] : undefined
  if (!check) return 'unknown'
  try {
    return await check(deps)
  } catch {
    return 'unknown'
  }
}

function defaultDeps(
  env: Readonly<Record<string, string | undefined>>,
  agent: AcpAuthProbeDeps['agent'],
): AcpAuthProbeDeps {
  return {
    env,
    agent,
    home: env['HOME'] ?? env['USERPROFILE'] ?? homedir(),
    fileExists: (path) =>
      access(path).then(
        () => true,
        (error: unknown) => {
          if (z.object({ code: z.literal('ENOENT') }).safeParse(error).success) return false
          throw error
        },
      ),
    exec: async (command, args): Promise<string> => {
      try {
        const pending = run(command, args, { env, timeout: 6000, maxBuffer: 64 * 1024 })
        // A launcher that ignores the status arguments and starts an ACP
        // server would otherwise wait on stdin until the timeout.
        pending.child.stdin?.end()
        const { stdout, stderr } = await pending
        return stdout.length > 0 ? stdout : stderr
      } catch (error) {
        // These status commands can return useful signed-out output with exit 1.
        // Missing binaries, signals, timeouts and other failures stay unknown.
        const result = z
          .object({ code: z.literal(1), stdout: z.string(), stderr: z.string() })
          .safeParse(error)
        if (result.success)
          return result.data.stdout.length > 0 ? result.data.stdout : result.data.stderr
        throw error
      }
    },
  }
}

/**
 * Sign-in state for every agent that is installed on this device. Agents that
 * are not installed are omitted: there is nothing to be signed in to yet.
 */
export async function detectAcpAuthStatus(
  ids: readonly string[],
  deps?: (
    env: Readonly<Record<string, string | undefined>>,
    agent: AcpAuthProbeDeps['agent'],
  ) => AcpAuthProbeDeps,
): Promise<AcpAuthStatus[]> {
  const makeDeps = deps ?? defaultDeps
  let saved: AcpAgentConfig[] = []
  try {
    saved = listAcpAgents()
  } catch {
    /* no saved env to consult; fall back to the scrubbed child environment */
  }
  return Promise.all(
    ids.map(async (id) => {
      const entry = saved.find((agent) => canonicalAcpAgentId(agent.id) === id)
      const known = KNOWN_ACP_AGENTS.find((agent) => agent.id === id)
      const launch = entry ?? known
      const agent = { command: launch?.command ?? id, args: launch?.args ?? [] }
      const env = buildAcpAgentEnv({
        command: agent.command,
        cwd: process.cwd(),
        ...(entry?.env ? { env: entry.env } : {}),
      })
      return { id, state: await probeAcpAuth(id, makeDeps(env, agent)) }
    }),
  )
}
