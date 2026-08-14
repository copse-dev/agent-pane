/**
 * Out-of-process ACP agent probe (phase 4 of docs/plans/sandbox-network-scope-isolation.md).
 *
 * Why a separate process at all: ASRT's network allowlist is **process-global**.
 * `SandboxManager` is a module singleton (`export const SandboxManager = {…}`)
 * whose proxies decide allow/deny against one config, and the per-spawn
 * `customConfig.network` is consumed only as a boolean — so widening the
 * allowlist for a sandboxed ACP agent widens it for every other child the same
 * process spawns. In the main process that meant a background model probe the
 * user never started could suspend shell auto-run in unrelated panes.
 *
 * Running the probe here gives it its own `SandboxManager`, so the agent is still
 * confined but its allowlist never touches the app's config. The worker itself
 * runs unsandboxed on the host: ASRT treats nesting as a degraded mode
 * (`enableWeakerNestedSandbox`), and the thing that needs confining is the agent
 * process this worker spawns, not this worker.
 *
 * Protocol: the spawn config arrives as JSON in COPSE_ACP_PROBE_REQUEST, and a
 * single JSON line goes to stdout — `{ok: true, probe}` or `{ok: false, error}`.
 * Diagnostics go to stderr so stdout stays parseable.
 *
 * Must stay free of electron and node-pty imports so it bundles as a standalone
 * script; `acp-client.ts` is kept bundleable for exactly this reason.
 */
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { baseSandboxConfig } from '../../project-sandbox/config.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { probeAcpAgent, type AcpAgentSpawnConfig } from './acp-client.ts'
import type { AcpAgentSandboxConfig } from '@shared/types/acp.ts'
import { errorMessage } from '@shared/errors.ts'
import { isRecord, parseJsonUnknown } from '@shared/unknown-value.ts'

export const ACP_PROBE_REQUEST_ENV = 'COPSE_ACP_PROBE_REQUEST'

/** Mirrors the main process's probe budget; the host also enforces its own. */
const DEFAULT_PROBE_TIMEOUT_MS = 15_000

interface ProbeRequest {
  config: AcpAgentSpawnConfig
  timeoutMs?: number
}

export function parseProbeRequest(raw: string): ProbeRequest | null {
  // parseJsonUnknown is a bare JSON.parse and throws; a malformed request must
  // become a structured `{ok:false}` line, never an unhandled rejection.
  let parsed: unknown
  try {
    parsed = parseJsonUnknown(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const config = parsed['config']
  if (!isRecord(config)) return null
  const command = config['command']
  const cwd = config['cwd']
  if (typeof command !== 'string' || typeof cwd !== 'string') return null
  const timeoutMs = parsed['timeoutMs']
  return {
    config: readSpawnConfig(config, command, cwd),
    ...(typeof timeoutMs === 'number' && timeoutMs > 0 ? { timeoutMs } : {}),
  }
}

/**
 * Rebuild the spawn config field by field rather than asserting the parsed JSON
 * into shape: it arrives over a process boundary, so it is untyped input.
 *
 * Only the fields the probe actually uses are carried — command, args, env, cwd,
 * and the sandbox confines. Dropping `sandbox` would silently unconfine the agent,
 * so it is validated rather than skipped; the session-only fields (model,
 * permissionMode, mcpServers, nativeBridge) are irrelevant to a probe, which never
 * prompts, and are deliberately not forwarded.
 */
function readSpawnConfig(
  config: Record<string, unknown>,
  command: string,
  cwd: string,
): AcpAgentSpawnConfig {
  const args = config['args']
  const env = readStringMap(config['env'])
  const sandbox = readSandboxConfig(config['sandbox'])
  return {
    command,
    cwd,
    ...(Array.isArray(args) && args.every((a) => typeof a === 'string') ? { args } : {}),
    ...(env ? { env } : {}),
    ...(sandbox ? { sandbox } : {}),
  }
}

/** Copy only string-valued entries, so the result is a string map by construction. */
function readStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

function readSandboxConfig(value: unknown): AcpAgentSandboxConfig | undefined {
  if (!isRecord(value)) return undefined
  const allowedDomains = value['allowedDomains']
  if (!Array.isArray(allowedDomains) || !allowedDomains.every((d) => typeof d === 'string')) {
    return undefined
  }
  const stringList = (key: string): string[] | undefined => {
    const list = value[key]
    return Array.isArray(list) && list.every((p) => typeof p === 'string') ? list : undefined
  }
  const homeDirs = stringList('homeDirs')
  const scratchPaths = stringList('scratchPaths')
  return {
    allowedDomains,
    ...(homeDirs ? { homeDirs } : {}),
    ...(scratchPaths ? { scratchPaths } : {}),
  }
}

/**
 * Bring up this process's own ASRT. Failure is not fatal: the probe then spawns
 * the agent unsandboxed, exactly as the main process degrades when ASRT cannot
 * initialize (missing bwrap, unsupported platform). The isolation this worker
 * exists for still holds — an unsandboxed agent acquires no network scope at all.
 */
async function initWorkerSandbox(): Promise<void> {
  try {
    await SandboxManager.initialize(baseSandboxConfig(), () => Promise.resolve(false), false)
    setProjectSandboxEnabled(true)
  } catch (err) {
    setProjectSandboxEnabled(false)
    console.error(
      `[acp-probe-worker] sandbox init failed, probing unsandboxed: ${errorMessage(err)}`,
    )
  }
}

async function main(): Promise<void> {
  const raw = process.env[ACP_PROBE_REQUEST_ENV] ?? ''
  const request = parseProbeRequest(raw)
  if (!request) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'invalid probe request' })}\n`)
    process.exitCode = 1
    return
  }
  await initWorkerSandbox()
  try {
    const probe = await probeAcpAgent(request.config, request.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
    process.stdout.write(`${JSON.stringify({ ok: true, probe })}\n`)
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: errorMessage(err) })}\n`)
  }
}

// The request env var is the sole entry signal, so importing this module (tests,
// the host reading ACP_PROBE_REQUEST_ENV) never starts a probe or exits the
// process. Do NOT add an argv fallback: the test runner passes its own argv,
// which would make an import self-execute.
if (process.env[ACP_PROBE_REQUEST_ENV] !== undefined) {
  void main().then(
    () => {
      // The agent child is torn down by probeAcpAgent; exit rather than linger on
      // any stray handle (ASRT's proxy keeps the loop alive).
      process.exit(process.exitCode ?? 0)
    },
    (err: unknown) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: errorMessage(err) })}\n`)
      process.exit(1)
    },
  )
}
