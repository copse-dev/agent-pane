/** Guest-only transport: curl honors the sandbox's proxy and CA configuration. */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export class HostedArchiveDownloadError extends Error {}

export async function downloadHostedArchive(url: URL, path: string): Promise<void> {
  const signal = AbortSignal.timeout(240_000)
  const child = spawn(
    'curl',
    [
      '--disable',
      '--config',
      '-',
      '--silent',
      '--show-error',
      '--fail',
      '--proto',
      '=https',
      '--max-time',
      '240',
      '--connect-timeout',
      '30',
      '--write-out',
      '%{stderr}\nCOPSE_HTTP:%{http_code}\n',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], signal },
  )
  let diagnostic = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    if (diagnostic.length < 16_384) diagnostic += chunk.slice(0, 16_384 - diagnostic.length)
  })
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', () => {
      resolve(null)
    })
    child.once('close', (code) => {
      resolve(code)
    })
  })
  child.stdin.on('error', () => {
    /* EPIPE is handled by the exit result. */
  })
  child.stdin.end(`url = ${JSON.stringify(url.href)}\n`)
  let bytes = 0
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      bytes += chunk.length
      callback(bytes > 2 * 1024 ** 3 ? new Error('Archive exceeds 2 GiB') : null, chunk)
    },
  })
  const copied = pipeline(
    child.stdout,
    bounded,
    createWriteStream(path, { flags: 'wx', mode: 0o600 }),
    { signal },
  )
  try {
    const [code] = await Promise.all([exited, copied])
    const status = /\nCOPSE_HTTP:([0-9]{3})\n/.exec(diagnostic)?.[1]
    // Without --location, even a successful curl process must reject redirects.
    if (code !== 0 || !status || !/^2[0-9]{2}$/.test(status))
      throw new HostedArchiveDownloadError(
        status && status !== '000'
          ? `HTTP ${status}`
          : `curl ${code === null ? 'unavailable' : String(code)}`,
      )
  } catch (error) {
    child.kill('SIGKILL')
    await Promise.allSettled([exited, copied])
    await rm(path, { force: true }).catch(() => {})
    if (error instanceof HostedArchiveDownloadError) throw error
    throw new HostedArchiveDownloadError(
      bytes > 2 * 1024 ** 3 ? 'download size limit' : 'download stream failed',
    )
  }
}
