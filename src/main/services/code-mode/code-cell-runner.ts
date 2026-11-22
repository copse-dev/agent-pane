/**
 * Guest entry for a code-cell container. Bundled by `scripts/main-bundles.mts`
 * into `dist/main/code-cell-runner.cjs`, copied into the code-cell image and
 * started by its entrypoint as an unprivileged user with no network.
 *
 * The container's stdin and stdout are the link to the host. Stdout's original
 * `write` is taken for the link first thing and the visible `process.stdout`
 * is pointed at stderr, so a stray `console.log` lands in the container's log
 * instead of inside a frame (the same rule as the thread-container worker).
 * When the host closes the link the runner exits, and the engine removes the
 * container.
 */
import { EgressLink } from '../container-runtime/egress-link.ts'
import { serveCodeCells } from './code-cell-guest.ts'

function claimStdioLink(onHostGone: () => void): EgressLink {
  const stdout = process.stdout
  const rawWrite = stdout.write.bind(stdout)
  const link = new EgressLink(
    process.stdin,
    {
      write: (chunk): boolean => rawWrite(chunk),
      on: (event, listener): void => {
        stdout.on(event, listener)
      },
    },
    { onClose: onHostGone },
  )
  const toStderr = (
    chunk: string | Uint8Array,
    encodingOrDone?: BufferEncoding | ((error?: Error | null) => void),
    done?: (error?: Error | null) => void,
  ): boolean =>
    typeof encodingOrDone === 'function'
      ? process.stderr.write(chunk, encodingOrDone)
      : process.stderr.write(chunk, encodingOrDone, done)
  stdout.write = toStderr
  return link
}

const link = claimStdioLink(() => {
  process.exit(0)
})
serveCodeCells(link, { nodeVersion: process.version }).then(
  () => {
    process.exit(0)
  },
  (error: unknown) => {
    process.stderr.write(`[code-cell] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  },
)
