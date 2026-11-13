import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { errorMessage } from '@shared/errors.ts'
import { isRecord, parseJsonUnknown } from '@shared/unknown-value.ts'
import type { AcpAgentProbe } from '@shared/types/acp.ts'
import { detachForGroupKill } from '../../project-sandbox/sandbox-argv.ts'
import { withoutSandboxWrapTmpPin } from '../../project-sandbox/tmp-env.ts'
import { terminateProcessTree } from '../exec/subprocess-kill.ts'
import { probeAcpAgent, willSandboxAcpAgent, type AcpAgentSpawnConfig } from './acp-client.ts'
import { ACP_PROBE_REQUEST_ENV } from './acp-probe-worker.ts'

/**
 * Run an ACP agent probe in a helper process that owns its own `SandboxManager`,
 * so the agent's network allowlist never widens the app's process-global one.
 *
 * See `acp-probe-worker.ts` for why a whole process is the unit of isolation: the
 * ASRT manager is a per-process singleton with no per-spawn network policy and no
 * way to attribute a connection back to a child, so the only way to give the probe
 * a different network policy is to give it a different process.
 *
 * A sandboxed probe fails closed if its helper cannot run. An unsandboxed probe
 * may fall back in process, since it never acquires an ASRT network scope.
 */

/** Bound on the helper's whole life, above the probe's own budget so the inner timeout wins. */
const HOST_TIMEOUT_GRACE_MS = 5_000
const WORKER_STDOUT_MAX_BYTES = 256 * 1024
const WORKER_STDERR_MAX_BYTES = 64 * 1024

export function acpProbeWorkerPath(): string {
  return join(__dirname, 'acp-probe-worker.js')
}

/**
 * Validate the selector shapes coming back over the worker's stdout rather than
 * asserting them: this crosses a process boundary, so the payload is untyped
 * input no matter that we wrote both ends. A malformed field degrades that
 * selector to `null` (the same value a probe that found nothing returns) instead
 * of surfacing a mistyped object to the picker.
 */
function readChoices(value: unknown): { value: string; label: string; description?: string }[] {
  if (!Array.isArray(value)) return []
  const choices: { value: string; label: string; description?: string }[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = entry['value']
    const label = entry['label']
    if (typeof id !== 'string' || typeof label !== 'string') continue
    const description = entry['description']
    choices.push({
      value: id,
      label,
      ...(typeof description === 'string' && description ? { description } : {}),
    })
  }
  return choices
}

function readModelSelector(value: unknown): AcpAgentProbe['models'] {
  if (!isRecord(value)) return null
  const configId = value['configId']
  const currentValue = value['currentValue']
  if (typeof configId !== 'string' || typeof currentValue !== 'string') return null
  return { configId, currentValue, choices: readChoices(value['choices']) }
}

function readModeSelector(value: unknown): AcpAgentProbe['modes'] {
  if (!isRecord(value)) return null
  const currentValue = value['currentValue']
  if (typeof currentValue !== 'string') return null
  return { currentValue, choices: readChoices(value['choices']) }
}

/** Parse the worker's single JSON line. Returns null when it is not a probe result. */
export function parseProbeWorkerOutput(stdout: string): AcpAgentProbe | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // The worker's stdout may carry non-JSON noise (a dependency writing to it);
    // skip anything unparseable rather than failing the whole probe.
    let parsed: unknown
    try {
      parsed = parseJsonUnknown(trimmed)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    if (parsed['ok'] === true && isRecord(parsed['probe'])) {
      const probe = parsed['probe']
      return { models: readModelSelector(probe['models']), modes: readModeSelector(probe['modes']) }
    }
    if (parsed['ok'] === false) {
      throw new Error(
        typeof parsed['error'] === 'string' ? parsed['error'] : 'Checking the coding agent failed',
      )
    }
  }
  return null
}

function runProbeWorker(
  config: AcpAgentSpawnConfig,
  timeoutMs: number,
  sandboxRequired: boolean,
): Promise<AcpAgentProbe> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [acpProbeWorkerPath()], {
      cwd: config.cwd,
      env: {
        // A wrap in flight here must not hand its scratch dir to a probe that
        // may run the agent unsandboxed (#4149).
        ...withoutSandboxWrapTmpPin(process.env),
        // Electron must run as Node for a plain script entry.
        ELECTRON_RUN_AS_NODE: '1',
        [ACP_PROBE_REQUEST_ENV]: JSON.stringify({ config, sandboxRequired, timeoutMs }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: detachForGroupKill,
    })
    let stdout = ''
    let stderr = ''
    let stderrBytes = 0
    let reportedStderr = false
    let settled = false
    const cancelEscalation = { current: null as (() => void) | null }
    // Settling and stopping the escalation are separate: a timed-out worker is
    // reported at once, but its SIGKILL fallback must stay armed until it exits.
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      cancelEscalation.current = terminateProcessTree(child)
      finish(() => {
        reject(new Error(`Checking the coding agent timed out after ${String(timeoutMs)}ms`))
      })
    }, timeoutMs + HOST_TIMEOUT_GRACE_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < WORKER_STDOUT_MAX_BYTES) stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = WORKER_STDERR_MAX_BYTES - stderrBytes
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining)
        stderr += kept.toString()
        stderrBytes += kept.length
      }
      if (!reportedStderr) {
        reportedStderr = true
        console.warn('[acp-probe-worker] worker wrote to stderr')
      }
    })
    child.once('error', (err) => {
      finish(() => {
        reject(err)
      })
    })
    child.once('close', (code) => {
      cancelEscalation.current?.()
      finish(() => {
        try {
          const probe = parseProbeWorkerOutput(stdout)
          if (probe) {
            resolve(probe)
            return
          }
          // This bounded excerpt stays in the rejected Error for diagnosis.
          // Current callers either mask it in Settings or swallow it during
          // auto-setup; never log arbitrary worker stderr directly here.
          reject(
            new Error(
              `Checking the coding agent stopped with code ${String(code)} and no result${
                stderr.trim() ? `: ${stderr.trim()}` : ''
              }`,
            ),
          )
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
  })
}

/**
 * Probe an ACP agent without widening this process's network allowlist.
 *
 * The helper is tried first. Only probes that do not use ASRT may fall back
 * in-process; a sandboxed probe's public-domain scope must stay off main.
 */
export async function probeAcpAgentIsolated(
  config: AcpAgentSpawnConfig,
  timeoutMs = 15_000,
): Promise<AcpAgentProbe> {
  const sandboxed = willSandboxAcpAgent(config.sandbox)
  try {
    return await runProbeWorker(config, timeoutMs, sandboxed)
  } catch (err) {
    if (sandboxed) throw err
    console.warn(
      `[acp-probe] isolated probe unavailable, falling back in-process: ${errorMessage(err)}`,
    )
    return probeAcpAgent(config, timeoutMs)
  }
}
