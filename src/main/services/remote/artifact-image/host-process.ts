/**
 * Main's launcher for the per-download host bundle. The host runs as Electron
 * in Node mode with an environment built from scratch: enough to find the
 * sandbox tools, nothing that carries a credential, proxy setting or Node
 * option. The job travels over stdin so the signed URL never appears in argv
 * or the environment.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { detachForGroupKill } from '../../../project-sandbox/sandbox-argv.ts'
import { terminateProcessTree } from '../../exec/subprocess-kill.ts'
import { ARTIFACT_IMAGE_HOST_DEADLINE_MS } from './host.ts'
import {
  BoundedLineSplitter,
  decodeLine,
  encodeFrame,
  errorFrame,
  zImageFrame,
  type HostJob,
  type ImageFrame,
} from './protocol.ts'

/** Host startup (ASRT, proxy) on top of the host's own deadline. */
const HOST_STARTUP_ALLOWANCE_MS = 10_000

export function artifactImageHostPath(): string {
  return join(__dirname, 'artifact-image-host.js')
}

/** The host's environment: no API keys, proxies, `NODE_OPTIONS` or CA overrides. */
export function artifactImageHostEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: env['PATH'] ?? '/usr/bin:/bin',
    ...(env['HOME'] ? { HOME: env['HOME'] } : {}),
    ...(env['TMPDIR'] ? { TMPDIR: env['TMPDIR'] } : {}),
    ELECTRON_RUN_AS_NODE: '1',
  }
}

/**
 * Run one job in a fresh host. Every frame the host prints is decoded and
 * delivered; an undecodable line, a timeout or an abort becomes one error frame
 * and kills the host's whole process group.
 */
export function runArtifactImageHost(
  job: HostJob,
  onFrame: (frame: ImageFrame) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [artifactImageHostPath()], {
      cwd: '/',
      env: artifactImageHostEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: detachForGroupKill,
    })
    let stopped = false
    const stop = (frame?: ImageFrame): void => {
      if (frame) onFrame(frame)
      if (stopped) return
      stopped = true
      terminateProcessTree(child)
    }
    const timer = setTimeout(() => {
      stop(errorFrame(job.requestId, 'timeout'))
    }, ARTIFACT_IMAGE_HOST_DEADLINE_MS + HOST_STARTUP_ALLOWANCE_MS)
    const onAbort = (): void => {
      stop()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    const splitter = new BoundedLineSplitter(
      (line) => {
        const frame = decodeLine(line, zImageFrame)
        if (frame) onFrame(frame)
        else stop(errorFrame(job.requestId, 'protocol'))
      },
      () => {
        stop(errorFrame(job.requestId, 'protocol'))
      },
    )
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      splitter.push(chunk)
    })
    // The host's diagnostics are codes and origins only; surface them.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.startsWith('[artifact-image-host] ')) console.warn(line.slice(0, 300))
      }
    })
    child.once('error', () => {
      stop(errorFrame(job.requestId, 'sandbox-unavailable'))
    })
    child.once('close', () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
    child.stdin.on('error', () => {})
    // stdin stays open: the host treats its closing as cancellation.
    child.stdin.write(encodeFrame(job))
  })
}
