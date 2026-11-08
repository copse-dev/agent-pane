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
import { z } from 'zod'
import { baseSandboxConfig } from '../../project-sandbox/config.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { probeAcpAgent, type AcpAgentSpawnConfig } from './acp-client.ts'
import { errorMessage } from '@shared/errors.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'

export const ACP_PROBE_REQUEST_ENV = 'COPSE_ACP_PROBE_REQUEST'

/** Mirrors the main process's probe budget; the host also enforces its own. */
const DEFAULT_PROBE_TIMEOUT_MS = 15_000

const sandboxSchema = z.object({
  allowedDomains: z.array(z.string()),
  homeDirs: z.array(z.string()).optional(),
  scratchPaths: z.array(z.string()).optional(),
  allowMacOsTrustd: z.boolean().optional(),
  allowMacOsKeychain: z.boolean().optional(),
})

const probeRequestSchema = z
  .object({
    config: z.object({
      command: z.string().min(1),
      cwd: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      sandbox: sandboxSchema.optional(),
    }),
    sandboxRequired: z.boolean(),
    timeoutMs: z.number().positive().optional(),
  })
  .refine((request) => !request.sandboxRequired || request.config.sandbox !== undefined)

interface ProbeRequest {
  config: AcpAgentSpawnConfig
  sandboxRequired: boolean
  timeoutMs?: number
}

export function parseProbeRequest(raw: string): ProbeRequest | null {
  const parsed = safeJsonParse(raw, decodeWithSchema(probeRequestSchema))
  if (!parsed) return null
  const config = parsed.config
  return {
    config: {
      command: config.command,
      cwd: config.cwd,
      ...(config.args === undefined ? {} : { args: config.args }),
      ...(config.env === undefined ? {} : { env: config.env }),
      ...(config.sandbox === undefined
        ? {}
        : {
            sandbox: {
              allowedDomains: config.sandbox.allowedDomains,
              ...(config.sandbox.homeDirs === undefined
                ? {}
                : { homeDirs: config.sandbox.homeDirs }),
              ...(config.sandbox.scratchPaths === undefined
                ? {}
                : { scratchPaths: config.sandbox.scratchPaths }),
              ...(config.sandbox.allowMacOsTrustd === undefined
                ? {}
                : { allowMacOsTrustd: config.sandbox.allowMacOsTrustd }),
              ...(config.sandbox.allowMacOsKeychain === undefined
                ? {}
                : { allowMacOsKeychain: config.sandbox.allowMacOsKeychain }),
            },
          }),
    },
    sandboxRequired: parsed.sandboxRequired,
    ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
  }
}

/**
 * Bring up this process's own ASRT only when main requested containment. An
 * initialization failure must reject the probe before the agent can spawn.
 */
async function initWorkerSandbox(required: boolean): Promise<void> {
  if (!required) return
  await SandboxManager.initialize(baseSandboxConfig(), () => Promise.resolve(false), false)
  if (!SandboxManager.isSandboxingEnabled()) {
    throw new Error('Cannot check this agent safely because workspace protection did not start')
  }
  setProjectSandboxEnabled(true)
}

async function main(): Promise<void> {
  const raw = process.env[ACP_PROBE_REQUEST_ENV] ?? ''
  const request = parseProbeRequest(raw)
  if (!request) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'invalid probe request' })}\n`)
    process.exitCode = 1
    return
  }
  await initWorkerSandbox(request.sandboxRequired)
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
