// Collect a spawned child's output under a cap and a deadline. Shared by every
// backend: the host-process backend spawns directly, the app's OS-sandbox
// backend spawns through the seatbelt wrapper, and both hand the child here.
import type { ChildProcess } from 'node:child_process'
import type { CellCommand, CellCommandResult } from './isolation.ts'

/** Append `chunk` to `current`, keeping at most `maxBytes` of the TAIL. */
export function appendTailCapped(
  current: string,
  chunk: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const joined = current + chunk
  const bytes = Buffer.byteLength(joined, 'utf8')
  if (bytes <= maxBytes) return { text: joined, truncated: false }
  // Drop from the front; the tail of a build or test log is where the verdict is.
  const buffer = Buffer.from(joined, 'utf8')
  return {
    text: buffer.subarray(buffer.length - maxBytes).toString('utf8'),
    truncated: true,
  }
}

/** Kill the child's whole process group when it was spawned detached, else the child. */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }
}

export interface CollectOptions {
  readonly now?: () => number
}

/**
 * Wait for `child` to exit, retaining a capped tail of its interleaved output.
 * On `timeoutMs` the whole process group is SIGKILLed and the result says so;
 * a timeout is a distinct outcome from a failing command, and the caller must
 * not read it as either a pass or a fail.
 */
export function collectProcess(
  child: ChildProcess,
  command: CellCommand,
  options: CollectOptions = {},
): Promise<CellCommandResult> {
  const now = options.now ?? Date.now
  const started = now()
  let output = ''
  let truncated = false
  let timedOut = false

  const onChunk = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const next = appendTailCapped(output, text, command.maxOutputBytes)
    output = next.text
    truncated = truncated || next.truncated
  }
  child.stdout?.on('data', onChunk)
  child.stderr?.on('data', onChunk)

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      killProcessTree(child, 'SIGKILL')
    }
    command.signal?.addEventListener('abort', onAbort, { once: true })
    if (command.signal?.aborted) onAbort()
    // The leader can exit while grandchildren still hold pipes or run with
    // ignored stdio. End the whole command lifetime at the leader's exit.
    child.once('exit', () => {
      killProcessTree(child, 'SIGKILL')
    })
    const timer =
      command.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            killProcessTree(child, 'SIGKILL')
          }, command.timeoutMs)
        : null
    child.once('error', (err) => {
      if (timer) clearTimeout(timer)
      command.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      command.signal?.removeEventListener('abort', onAbort)
      if (command.signal?.aborted) {
        reject(
          command.signal.reason instanceof Error
            ? command.signal.reason
            : new Error('Review command cancelled'),
        )
        return
      }
      resolve({
        target: command.target,
        argv: [...command.argv],
        exitCode: code,
        signal,
        timedOut,
        durationMs: now() - started,
        output,
        outputTruncated: truncated,
      })
    })
  })
}
