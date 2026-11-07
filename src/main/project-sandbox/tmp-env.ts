import { join, sep } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

/**
 * Route both ordinary temp files and zsh's heredoc files into the allowed scratch directory.
 *
 * This only covers the environment Copse hands to `spawn`. ASRT additionally
 * bakes its own `TMPDIR=…` into the wrapped command (`env TMPDIR=… sandbox-exec
 * …`), and that assignment runs inside the spawned process, so it wins over the
 * `TMPDIR` set here. Wrap through {@link withSandboxWrapTmpDir} with the same
 * directory so the two agree.
 */
export function withSandboxTmpEnv(env: NodeJS.ProcessEnv, tmpDir: string): NodeJS.ProcessEnv {
  // zsh uses TMPPREFIX (default /tmp/zsh), not TMPDIR, when a heredoc needs a
  // file. Redirecting TMPDIR alone therefore breaks large patches under the
  // workspace sandbox. TMPPREFIX is a filename prefix, not a directory.
  return {
    ...env,
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    TMPPREFIX: join(tmpDir, 'zsh'),
    CLAUDE_CODE_TMPDIR: tmpDir,
  }
}

/**
 * ASRT's own `TMPDIR` when the wrapping process names none. ASRT always lets a
 * wrapped command write it (`getDefaultWritePaths` in `sandbox-utils.js`).
 */
export const ASRT_FALLBACK_TMPDIR = '/tmp/claude'

/** Whether a write grant (a path, or a path ending in `/**`) covers `dir`. */
function grantCovers(grant: string, dir: string): boolean {
  const root = grant.endsWith('/**') ? grant.slice(0, -3) : grant
  // Any other glob is pattern-matched by seatbelt but dropped by bubblewrap, so
  // it cannot promise a writable directory on both platforms.
  if (/[*?[\]{}]/.test(root)) return false
  return dir === root || dir.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * The temp directory for a command wrapped with `overlay`: `preferred` when
 * the overlay lets the command write it, otherwise {@link ASRT_FALLBACK_TMPDIR}.
 * A read-only overlay (`allowWrite: []`) cannot write the workspace scratch
 * directory, so pointing its temp variables there would fail every `mkdtemp`.
 */
export function sandboxTmpDirFor(
  overlay: Partial<SandboxRuntimeConfig>,
  preferred: string,
): string {
  const filesystem = overlay.filesystem
  // With filesystem policy off ASRT bakes no TMPDIR and every directory is writable.
  if (filesystem?.disabled === true) return preferred
  const writable =
    filesystem !== undefined &&
    filesystem.allowWrite.some((grant) => grantCovers(grant, preferred)) &&
    !filesystem.denyWrite.some((grant) => grantCovers(grant, preferred))
  return writable ? preferred : ASRT_FALLBACK_TMPDIR
}

interface WrapTmpPin {
  readonly tmpDir: string
  /** This process's value before the pin: the user's own, or none. */
  readonly saved: string | undefined
  holders: number
}

let activePin: WrapTmpPin | undefined
const queuedPins: { readonly tmpDir: string; readonly admit: () => void }[] = []

function startPin(tmpDir: string): WrapTmpPin {
  const pin = { tmpDir, saved: process.env['CLAUDE_CODE_TMPDIR'], holders: 1 }
  process.env['CLAUDE_CODE_TMPDIR'] = tmpDir
  activePin = pin
  return pin
}

function acquirePin(tmpDir: string): Promise<void> {
  if (!activePin) {
    startPin(tmpDir)
    return Promise.resolve()
  }
  // Join a pin for the same directory, unless a wrap for another directory is
  // already waiting for this one to end.
  if (activePin.tmpDir === tmpDir && queuedPins.length === 0) {
    activePin.holders += 1
    return Promise.resolve()
  }
  return new Promise((admit) => {
    queuedPins.push({ tmpDir, admit })
  })
}

function releasePin(): void {
  const pin = activePin
  if (!pin) return
  pin.holders -= 1
  if (pin.holders > 0) return
  activePin = undefined
  // Leave alone a value someone else set while the pin was held.
  if (process.env['CLAUDE_CODE_TMPDIR'] === pin.tmpDir) {
    if (pin.saved === undefined) delete process.env['CLAUDE_CODE_TMPDIR']
    else process.env['CLAUDE_CODE_TMPDIR'] = pin.saved
  }
  const first = queuedPins.shift()
  if (!first) return
  const next = startPin(first.tmpDir)
  first.admit()
  while (queuedPins[0]?.tmpDir === next.tmpDir) {
    queuedPins.shift()?.admit()
    next.holders += 1
  }
}

/**
 * Run one ASRT wrap so the `TMPDIR` it bakes into the command is `tmpDir` (#4149).
 *
 * `SandboxManager.wrapWithSandboxArgv` reads
 * `process.env.CLAUDE_CODE_TMPDIR || process.env.CLAUDE_TMPDIR || '/tmp/claude'`
 * from the *wrapping* process and bakes it into the wrapped command as
 * `env TMPDIR=<that>` (macOS) or `--setenv TMPDIR <that>` (Linux). That runs
 * inside the child after Copse's spawn env, so it decides the child's `TMPDIR`.
 * ASRT 0.0.74 offers no per-call option for it.
 *
 * ASRT reads it after an `await` inside the wrap, so the value lives in
 * `process.env` only while a wrap is in flight and is restored when the wrap
 * settles. Nothing Copse spawns afterwards inherits it: an unsandboxed Claude
 * Code must never keep its `claude-<uid>` files in a directory every sandboxed
 * command can write. Concurrent wraps for the same directory share the pin; a
 * wrap for another directory waits for it to end. A child env built from
 * `process.env` while a wrap is in flight must go through
 * {@link withoutSandboxWrapTmpPin}.
 */
export async function withSandboxWrapTmpDir<T>(tmpDir: string, wrap: () => Promise<T>): Promise<T> {
  await acquirePin(tmpDir)
  try {
    return await wrap()
  } finally {
    releasePin()
  }
}

/**
 * `env` with the user's own `CLAUDE_CODE_TMPDIR` (or none) in place of the
 * value an in-flight {@link withSandboxWrapTmpDir} pinned in `process.env`.
 * Returned unchanged when no wrap is in flight or `env` does not carry the pin.
 */
export function withoutSandboxWrapTmpPin(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pin = activePin
  if (!pin || env['CLAUDE_CODE_TMPDIR'] !== pin.tmpDir) return env
  const restored = { ...env }
  if (pin.saved === undefined) delete restored['CLAUDE_CODE_TMPDIR']
  else restored['CLAUDE_CODE_TMPDIR'] = pin.saved
  return restored
}
