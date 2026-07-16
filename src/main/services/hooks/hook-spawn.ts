// Shared command-hook spawn machinery (A2 of the hooks platform).
//
// Every dialect adapter (Cursor / Claude / Copse) spawns its hook the same way:
// a shell child process fed the dialect wire payload on stdin, with stdout the
// response channel and stderr captured for the spine (decision 6 — stderr was
// previously discarded). Only the *marshalling* of stdin and the *interpretation*
// of the exit code + stdout differ per dialect; the process plumbing is shared
// here so the adapters stay focused on their wire contract.
//
// This module lives host-side (`src/main/services/hooks/`) — execution-guidance
// rule 4: spawning is Electron-adjacent host code, never `packages/agent`.
import { spawn } from 'node:child_process'
import { envForRendererChildProcess } from '../exec/child-process-env.ts'

/** Default per-hook timeout. Vendor-specific overrides live in each adapter (decision 13, H4). */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000

/** Cap captured stream sizes so a runaway hook can't exhaust memory. */
const OUTPUT_CAP_BYTES = 1_000_000

/** Everything observed about one spawned hook process, before dialect interpretation. */
export interface HookSpawnResult {
  /** Raw captured stdout (the response channel), verbatim for the spine blob. */
  stdout: string
  /** Raw captured stderr, verbatim for the spine blob (decision 6). */
  stderr: string
  /** Process exit code; null when killed (timeout / output cap) or spawn failed. */
  exitCode: number | null
  /** True when the process was killed for exceeding its timeout. */
  timedOut: boolean
  /** True when the process failed to start (spawn error / stdin write error). */
  spawnError: boolean
  startedAt: number
  durationMs: number
}

export interface HookSpawnOptions {
  /** Working directory; relative commands resolve against it. */
  cwd: string
  /** Kill the process after this many ms (treated by adapters as a failure). */
  timeoutMs?: number
  /** Abort signal for the current run; kills the process when it fires. */
  signal?: AbortSignal
}

/**
 * Spawn one hook command through a shell, write `stdinPayload` (JSON-serialized)
 * to its stdin, and resolve once it closes / is killed. Never rejects: a spawn
 * failure is reported as `spawnError`, a timeout as `timedOut`, so the caller's
 * dialect exit-code table (decision 9) is the single place failure semantics
 * are decided.
 *
 * The process inherits `envForRendererChildProcess()` — the same secret-scrubbed
 * env as `run_shell`, so LLM provider keys never reach hook scripts (non-LLM
 * tool tokens remain; that is the documented trust boundary, docs/cursor-hooks.md).
 */
export function spawnHookProcess(
  command: string,
  stdinPayload: unknown,
  opts: HookSpawnOptions,
): Promise<HookSpawnResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null
    let timedOut = false
    let settled = false

    const finish = (spawnError: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
        spawnError,
        startedAt,
        durationMs: Date.now() - startedAt,
      })
    }

    // Hook commands are arbitrary user/project-supplied shell, run outside the
    // project sandbox with non-LLM tool tokens present in `env`. This is gated
    // by workspace trust + `cursorHooksEnabled`; see docs/cursor-hooks.md#security.
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      env: envForRendererChildProcess(),
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.signal ? { signal: opts.signal } : {}),
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      finish(false)
    }, opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      // stdout is the response channel: a runaway response is fatal to the hook.
      if (stdout.length <= OUTPUT_CAP_BYTES) stdout += chunk.toString('utf-8')
      else child.kill('SIGKILL')
    })
    // Overflow only truncates the stderr capture; it never kills the hook,
    // because stderr chatter carries no decision.
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length <= OUTPUT_CAP_BYTES) stderr += chunk.toString('utf-8')
    })
    child.on('error', () => {
      finish(true)
    })
    child.on('close', (code) => {
      exitCode = code
      finish(false)
    })

    // A process that exits before draining stdin (e.g. a command that does not
    // exist, or one that never reads its input) makes the write race the close:
    // the pipe can be gone by the time we write, surfacing as an async EPIPE on
    // the stdin stream. Swallow it — the close/error handlers own the outcome —
    // so it never becomes an unhandled exception.
    child.stdin.on('error', () => {
      /* the process closed its input early; the decision comes from close/error */
    })
    try {
      child.stdin.end(JSON.stringify(stdinPayload))
    } catch {
      finish(true)
    }
  })
}
