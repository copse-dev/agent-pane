// Collect a spawned child's output under a cap and a deadline. Shared by every
// backend: the host-process backend spawns directly, the app's OS-sandbox
// backend spawns through the seatbelt wrapper, and both hand the child here.
import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { signalProcessTree } from '@copse/std/process-tree.ts'
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
  signalProcessTree(child, signal)
}

/**
 * How long output may keep draining after the leader exits. A grandchild that
 * left the process group (`setsid`, a detached spawn) can hold the pipes open
 * forever; `close` would never fire, and neither the timeout nor an abort
 * could end the command. After this grace the pipes are closed from our end.
 */
const EXIT_DRAIN_GRACE_MS = 500

/** At most this much of `retainLinePrefixes` lines is kept; a failure inventory is far smaller. */
export const MAX_RETAINED_LINE_BYTES = 1024 * 1024

/**
 * Collects the lines that start with one of `prefixes`, per stream and across
 * chunk boundaries, up to {@link MAX_RETAINED_LINE_BYTES} in all.
 */
class RetainedLines {
  readonly lines: string[] = []
  private bytes = 0
  private readonly partial = new Map<string, string>()
  private readonly prefixes: readonly string[]

  constructor(prefixes: readonly string[]) {
    this.prefixes = prefixes
  }

  add(stream: string, text: string): void {
    const pending = (this.partial.get(stream) ?? '') + text
    const parts = pending.split('\n')
    const last = parts.pop() ?? ''
    for (const line of parts) this.keep(line)
    // A partial line longer than the budget can never be kept; stop buffering it.
    this.partial.set(stream, Buffer.byteLength(last, 'utf8') > MAX_RETAINED_LINE_BYTES ? '' : last)
  }

  flush(): void {
    for (const last of this.partial.values()) this.keep(last)
    this.partial.clear()
  }

  private keep(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!this.prefixes.some((prefix) => line.startsWith(prefix))) return
    const size = Buffer.byteLength(line, 'utf8')
    if (this.bytes + size > MAX_RETAINED_LINE_BYTES) return
    this.lines.push(line)
    this.bytes += size
  }
}

export interface CollectOptions {
  readonly now?: () => number
  /**
   * How to end the command early (timeout, abort, or the leader exiting with
   * descendants still alive). Default: SIGKILL the child's process group. A
   * backend whose child is only a client for the real process — a container
   * engine's `run` — supplies the kill that reaches the process itself.
   */
  readonly kill?: (child: ChildProcess) => void
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
  const kill =
    options.kill ??
    ((target: ChildProcess): void => {
      killProcessTree(target, 'SIGKILL')
    })
  const started = now()
  let output = ''
  let truncated = false
  let timedOut = false

  const prefixes = command.retainLinePrefixes ?? []
  const retained = prefixes.length === 0 ? null : new RetainedLines(prefixes)
  const append = (stream: string, text: string): void => {
    if (text.length === 0) return
    retained?.add(stream, text)
    const next = appendTailCapped(output, text, command.maxOutputBytes)
    output = next.text
    truncated = truncated || next.truncated
  }
  // One decoder per stream: a character whose bytes arrive in two chunks is
  // held until it is whole, rather than decoded as two U+FFFD halves. Test
  // names are compared exactly, and many of them are not ASCII.
  const decoders = new Map<string, StringDecoder>()
  const onChunk =
    (stream: string) =>
    (chunk: Buffer | string): void => {
      if (typeof chunk === 'string') {
        append(stream, chunk)
        return
      }
      let decoder = decoders.get(stream)
      if (decoder === undefined) {
        decoder = new StringDecoder('utf8')
        decoders.set(stream, decoder)
      }
      append(stream, decoder.write(chunk))
    }
  /** Whatever a decoder still holds when its stream ends: an incomplete character, as U+FFFD. */
  const flushDecoders = (): void => {
    for (const [stream, decoder] of decoders) append(stream, decoder.end())
    decoders.clear()
  }
  child.stdout?.on('data', onChunk('stdout'))
  child.stderr?.on('data', onChunk('stderr'))
  /** The tail, with any retained line the cap dropped put back ahead of it. */
  const collected = (): string => {
    if (retained === null || !truncated) return output
    retained.flush()
    const dropped = retained.lines.filter((line) => !output.includes(line))
    return dropped.length === 0 ? output : `${dropped.join('\n')}\n${output}`
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      kill(child)
    }
    command.signal?.addEventListener('abort', onAbort, { once: true })
    if (command.signal?.aborted) onAbort()
    let exited = false
    let drain: NodeJS.Timeout | null = null
    // The leader can exit while grandchildren still hold pipes or run with
    // ignored stdio. End the whole command lifetime at the leader's exit, and
    // stop waiting on pipes that something outside the group still holds.
    child.once('exit', () => {
      exited = true
      kill(child)
      drain = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
      }, EXIT_DRAIN_GRACE_MS)
      drain.unref()
    })
    const timer =
      command.timeoutMs > 0
        ? setTimeout(() => {
            // Only the leader outrunning the deadline is a timeout; output
            // still draining after a normal exit is not.
            if (exited) return
            timedOut = true
            kill(child)
          }, command.timeoutMs)
        : null
    child.once('error', (err) => {
      if (timer) clearTimeout(timer)
      command.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      if (drain) clearTimeout(drain)
      command.signal?.removeEventListener('abort', onAbort)
      flushDecoders()
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
        output: collected(),
        outputTruncated: truncated,
      })
    })
  })
}
