import type { ChildProcess } from 'node:child_process'

const ACP_STDERR_TAIL_LIMIT = 8_000

/** Keep the last {@link ACP_STDERR_TAIL_LIMIT} characters of an agent's stderr. */
export function appendAcpStderrTail(current: string, text: string): string {
  const next = current + text
  return next.length <= ACP_STDERR_TAIL_LIMIT ? next : next.slice(-ACP_STDERR_TAIL_LIMIT)
}

export function acpProcessExitError(
  command: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): Error {
  const reason = signal ? `signal ${signal}` : `code ${code === null ? 'unknown' : String(code)}`
  const detail = stderr.trim()
  return new Error(
    `The coding agent "${command}" exited with ${reason}${detail ? `. Its error output: ${detail}` : ''}`,
  )
}

function acpProcessSpawnError(command: string, err: Error, stderr: string): Error {
  const detail = stderr.trim()
  return new Error(
    `The coding agent "${command}" failed to start: ${err.message}${detail ? `. Its error output: ${detail}` : ''}`,
  )
}

/**
 * The agent's stdout as a web stream that ends with the process: a clean exit
 * closes it, a spawn failure or non-zero exit errors it with the stderr tail.
 * Cancelling the read (closing the connection) detaches and calls `stop`.
 */
export function acpChildStdoutStream(
  child: ChildProcess,
  command: string,
  stderrTail: () => string,
  stop: () => void,
): ReadableStream<Uint8Array> {
  const stdout = child.stdout
  if (!stdout) throw new Error('The coding agent started without a way to read its output')
  let cancelRead = stop
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      let settled = false
      const cleanup = (): void => {
        stdout.off('data', onData)
        stdout.off('error', onStdoutError)
        child.off('error', onChildError)
        child.off('close', onChildClose)
      }
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        fn()
      }
      const onData = (chunk: Buffer): void => {
        controller.enqueue(new Uint8Array(chunk))
      }
      const onStdoutError = (err: Error): void => {
        settle(() => {
          controller.error(err)
        })
      }
      const onChildError = (err: Error): void => {
        settle(() => {
          controller.error(acpProcessSpawnError(command, err, stderrTail()))
        })
      }
      const onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (code === 0 && signal === null) {
          settle(() => {
            controller.close()
          })
        } else {
          settle(() => {
            controller.error(acpProcessExitError(command, code, signal, stderrTail()))
          })
        }
      }
      cancelRead = (): void => {
        if (!settled) {
          settled = true
          cleanup()
        }
        stop()
      }
      stdout.on('data', onData)
      stdout.on('error', onStdoutError)
      child.once('error', onChildError)
      child.once('close', onChildClose)
    },
    cancel(): void {
      cancelRead()
    },
  })
}
