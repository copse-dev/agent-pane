// Shared command-hook spawn machinery (A2 of the hooks platform).
//
// Every dialect adapter (Cursor / Claude / Copse) spawns its hook the same way:
// a shell child process fed the dialect wire payload on stdin, with stdout the
// response channel and stderr captured for the spine (decision 6 — stderr was
// previously discarded). Only the *marshalling* of stdin and the *interpretation*
// of the exit code + stdout differ per dialect; the process plumbing is shared
// here so the adapters stay focused on their wire contract.
//
// F3 (decision 7) reversed the spawn default: hook processes now run **inside
// the project sandbox by default** (reversing the earlier outside-sandbox
// spawn), with the Copse `sandbox: false` per-hook escape as the only opt-out.
// Enforcement is macOS-only (seatbelt via ASRT); on other platforms
// `isProjectSandboxEnabled()` is hard-false, so "sandboxed" is a *default*, not
// a guarantee. A sandbox-blocked hook never fail-opens silently — the runner
// keys off the recorded violation count here (never the hook's own stdout).
//
// This module lives host-side (`src/main/services/hooks/`) — execution-guidance
// rule 4: spawning is Electron-adjacent host code, never `packages/agent`.
import { spawn, type ChildProcess } from 'node:child_process'
import {
  afterSandboxedCommand,
  isProjectSandboxEnabled,
  sandboxViolationCountForCommand,
  spawnShellInProjectSandbox,
} from '../../project-sandbox/index.ts'
import { childHookEnv, currentHookDepth, HOOK_DEPTH_ENV } from './hook-depth.ts'

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
  /**
   * Whether this run actually went through the project sandbox (F3, decision 7).
   * True only when the hook was sandboxed-by-default *and* an OS sandbox is
   * active (macOS seatbelt) — a *default*, not a guarantee, so on Linux / Windows
   * or for a `sandbox: false` escape this is false. The runner keys its
   * blocked-by-sandbox detection off this + {@link sandboxViolationCount}.
   */
  sandboxed: boolean
  /**
   * Sandbox policy violations the runner (ASRT/seatbelt) recorded for this
   * command (runner-side signal, never derived from the hook's own stdout — issue
   * #104). Always 0 for an unsandboxed run. A non-zero count on a non-zero exit is
   * the trustworthy "the sandbox blocked this hook" signal.
   */
  sandboxViolationCount: number
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
  /**
   * Session-scoped environment overlay (H4). Merged on top of the scrubbed
   * {@link childHookEnv} so a `sessionStart` hook's `env` output reaches every
   * later hook process spawned in the same session (decision-doc "`sessionStart`
   * env propagation"). The overlay never removes the depth guard / scrubbing —
   * it only adds session vars, applied last so it cannot clobber
   * `COPSE_HOOK_DEPTH`.
   */
  sessionEnv?: Record<string, string>
  /**
   * Whether the hook runs **inside the project sandbox** (F3, decision 7). Hooks
   * are sandboxed by default; `false` is the Copse `sandbox: false` escape. The
   * OS sandbox is macOS-only, so even a sandboxed hook only runs contained when
   * {@link isProjectSandboxEnabled} — a default, not a guarantee. Absent = the
   * default (sandboxed).
   */
  sandbox?: boolean
}

/**
 * Injectable seam over the (macOS-only, native) project sandbox so hook-spawn
 * stays testable on Linux CI without real seatbelt (F3 acceptance: "mock/fake
 * sandbox if needed"). The real implementation delegates to the project-sandbox
 * module; tests swap in a fake that can simulate a sandboxed spawn and report
 * synthetic violation counts.
 */
export interface HookSandboxRuntime {
  /** Whether an OS sandbox boundary is active (macOS seatbelt initialized). */
  enabled(): boolean
  /** Spawn a shell command line inside the project sandbox (stdio piped). */
  spawnShell(
    command: string,
    opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
  ): Promise<ChildProcess>
  /** Runner-recorded sandbox policy violations for this command (never stdout-derived). */
  violationCount(command: string): number
  /** Per-command sandbox cleanup, mirroring the shell tool's `afterSandboxedCommand`. */
  afterCommand(): void
}

const realSandboxRuntime: HookSandboxRuntime = {
  enabled: isProjectSandboxEnabled,
  spawnShell: (command, opts) =>
    spawnShellInProjectSandbox(command, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.signal ? { signal: opts.signal } : {}),
    }),
  violationCount: sandboxViolationCountForCommand,
  afterCommand: afterSandboxedCommand,
}

let sandboxRuntime: HookSandboxRuntime = realSandboxRuntime

/** Swap the sandbox runtime for a test fake; pass null to restore the real one. */
export function setHookSandboxRuntimeForTest(runtime: HookSandboxRuntime | null): void {
  sandboxRuntime = runtime ?? realSandboxRuntime
}

/** Reject when `promise` does not settle within `ms` (wedged sandbox wrapper). */
function promiseWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`sandbox wrapper did not start within ${String(ms)}ms`))
    }, ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/**
 * Spawn one hook command through a shell, write `stdinPayload` (JSON-serialized)
 * to its stdin, and resolve once it closes / is killed. Never rejects: a spawn
 * failure is reported as `spawnError`, a timeout as `timedOut`, so the caller's
 * dialect exit-code table (decision 9) is the single place failure semantics
 * are decided.
 *
 * The process inherits `childHookEnv()` — the same secret-scrubbed env as
 * `run_shell` (so LLM provider keys never reach hook scripts; non-LLM tool
 * tokens remain, the documented trust boundary in docs/cursor-hooks.md) plus a
 * bumped `COPSE_HOOK_DEPTH` so a Copse re-entered from the hook suppresses its
 * own hooks (decision 5 recursion guard).
 */
export async function spawnHookProcess(
  command: string,
  stdinPayload: unknown,
  opts: HookSpawnOptions,
): Promise<HookSpawnResult> {
  // F3 (decision 7): hooks are sandboxed by default — the `sandbox: false`
  // escape (Copse-only) is the sole opt-out. The OS sandbox is macOS-only, so
  // this only *contains* the hook when an OS boundary is actually active; on
  // Linux / Windows it is a no-op default, never a guarantee.
  const sandboxed = opts.sandbox !== false && sandboxRuntime.enabled()
  const startedAt = Date.now()
  const depthEnv = { [HOOK_DEPTH_ENV]: String(currentHookDepth() + 1) }

  let child: ChildProcess
  try {
    if (sandboxed) {
      // The sandbox spawner supplies the scrubbed base env + the workspace-owned
      // $TMPDIR (which the seatbelt allows); overlay only the hook-specific vars
      // — session env (H4) then the depth guard last, so a session var can never
      // clobber `COPSE_HOOK_DEPTH` (the recursion guard, decision 5).
      const overlay: NodeJS.ProcessEnv = { ...(opts.sessionEnv ?? {}), ...depthEnv }
      // Race the wrapper against the hook's own timeout: the kill timer below
      // only arms once a ChildProcess exists, so a wedged sandbox-wrapper
      // promise would otherwise hang a *blocking* hook indefinitely (with the
      // run deadline paused, H4). A wrapper that loses the race is reported as
      // a spawn error — same failure surface as a wrapper throw.
      const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
      child = await promiseWithTimeout(
        sandboxRuntime.spawnShell(command, {
          cwd: opts.cwd,
          env: overlay,
          ...(opts.signal ? { signal: opts.signal } : {}),
        }),
        timeoutMs,
      )
    } else {
      // Unsandboxed path: arbitrary user/project shell with non-LLM tool tokens
      // present in `env`, gated by workspace trust + `cursorHooksEnabled` (see
      // docs/cursor-hooks.md#security). Session env (H4) is layered on the
      // scrubbed child env, depth guard re-applied last.
      const baseEnv = childHookEnv()
      const env = opts.sessionEnv ? { ...baseEnv, ...opts.sessionEnv, ...depthEnv } : baseEnv
      child = spawn(command, {
        cwd: opts.cwd,
        shell: true,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    }
  } catch {
    // The sandbox wrapper itself failed to start (runner-side, not command
    // output). Report it as a spawn error — the runner's blocked-by-sandbox
    // detection treats a sandboxed spawn failure as a block (never fail-open).
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      spawnError: true,
      sandboxed,
      sandboxViolationCount: 0,
      startedAt,
      durationMs: Date.now() - startedAt,
    }
  }

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null
    let timedOut = false
    let settled = false

    const finish = (spawnError: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Query the runner-recorded violation count BEFORE per-command cleanup,
      // matching the shell tool's ordering. Only meaningful for a sandboxed run.
      const sandboxViolationCount = sandboxed ? sandboxRuntime.violationCount(command) : 0
      if (sandboxed) sandboxRuntime.afterCommand()
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
        spawnError,
        sandboxed,
        sandboxViolationCount,
        startedAt,
        durationMs: Date.now() - startedAt,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      finish(false)
    }, opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      // stdout is the response channel: a runaway response is fatal to the hook.
      if (stdout.length <= OUTPUT_CAP_BYTES) stdout += chunk.toString('utf-8')
      else child.kill('SIGKILL')
    })
    // Overflow only truncates the stderr capture; it never kills the hook,
    // because stderr chatter carries no decision.
    child.stderr?.on('data', (chunk: Buffer) => {
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
    child.stdin?.on('error', () => {
      /* the process closed its input early; the decision comes from close/error */
    })
    try {
      child.stdin?.end(JSON.stringify(stdinPayload))
    } catch {
      finish(true)
    }
  })
}
