/**
 * Entry point of the ASRT-confined artifact-image downloader.
 *
 * Reads exactly one job line from stdin (never argv or env: the signed URL is a
 * bearer secret), downloads through the job's egress proxy and writes framed
 * bytes to stdout. Diagnostics carry only error codes. Must stay free of
 * electron and node-pty so it runs as a plain Node bundle.
 */
import { ArtifactImageError } from './policy.ts'
import { downloadArtifactImage, proxyPortFromEnv, proxyTunnelTransport } from './downloader.ts'
import {
  BoundedLineSplitter,
  decodeLine,
  encodeFrame,
  errorFrame,
  imageFrames,
  zDownloaderJob,
  type DownloaderJob,
} from './protocol.ts'

function readJob(): Promise<DownloaderJob | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (job: DownloaderJob | null): void => {
      if (done) return
      done = true
      process.stdin.pause()
      resolve(job)
    }
    const splitter = new BoundedLineSplitter(
      (line) => {
        finish(decodeLine(line, zDownloaderJob))
      },
      () => {
        finish(null)
      },
    )
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      splitter.push(chunk)
    })
    process.stdin.once('end', () => {
      finish(null)
    })
  })
}

function write(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!process.stdout.write(text)) process.stdout.once('drain', resolve)
    else resolve()
  })
}

async function main(): Promise<void> {
  const job = await readJob()
  if (!job) {
    process.exitCode = 2
    return
  }
  const port = proxyPortFromEnv(process.env)
  if (port === null) {
    await write(encodeFrame(errorFrame(job.requestId, 'sandbox-unavailable')))
    process.exitCode = 1
    return
  }
  try {
    const image = await downloadArtifactImage(job, proxyTunnelTransport(port, job.proxyToken))
    for (const frame of imageFrames(job.requestId, image.mime, image.bytes)) {
      await write(encodeFrame(frame))
    }
  } catch (error) {
    const failure = error instanceof ArtifactImageError ? error : new ArtifactImageError('network')
    await write(encodeFrame(errorFrame(job.requestId, failure.code, failure.origin)))
    process.exitCode = 1
  }
}

void main().then(
  () => {
    process.exit()
  },
  () => {
    process.exit(1)
  },
)
