/**
 * Process entry of the per-download artifact-image host. Main spawns this
 * with a minimal environment and writes one job line to stdin; the host
 * answers with frames on stdout and exits. Closing stdin (including the parent
 * dying) cancels the job and tears everything down.
 *
 * Must stay free of electron and node-pty so it runs as a plain Node bundle.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { isDefined } from '@shared/nullish.ts'
import { electronRuntimeAllowReadPaths } from '../../../project-sandbox/config.ts'
import {
  resolveSandboxShellExecutable,
  shellForSandboxWrap,
} from '../../../project-sandbox/sandbox-argv.ts'
import { startEgressProxy } from './egress-proxy.ts'
import { runArtifactImageHostJob, type HostDependencies } from './host.ts'
import { BoundedLineSplitter, decodeLine, encodeFrame, zHostJob, type HostJob } from './protocol.ts'

export const ARTIFACT_IMAGE_DOWNLOADER_BUNDLE = 'artifact-image-downloader.js'

const dependencies: HostDependencies = {
  sandbox: {
    async initialize(config) {
      if (process.platform === 'win32' || !SandboxManager.isSupportedPlatform()) {
        throw new Error('no sandbox backend on this platform')
      }
      // The ask-callback never grants: the allowlist is decided before startup.
      await SandboxManager.initialize(config, () => Promise.resolve(false), false)
    },
    wrap: (command) => {
      // Linux reaches the proxy through ASRT's Unix-socket bridge, created in
      // the temp directory the profile denies. Re-allow exactly those sockets:
      // without them the in-namespace socat has nothing to connect to.
      const filesystem = SandboxManager.getConfig()?.filesystem
      const bridgeSockets = [
        SandboxManager.getLinuxHttpSocketPath(),
        SandboxManager.getLinuxSocksSocketPath(),
      ].filter(isDefined)
      return SandboxManager.wrapWithSandboxArgv(
        command,
        shellForSandboxWrap(),
        filesystem && bridgeSockets.length > 0
          ? {
              filesystem: {
                ...filesystem,
                allowRead: [...new Set([...(filesystem.allowRead ?? []), ...bridgeSockets])],
              },
            }
          : undefined,
      )
    },
    reset: () => SandboxManager.reset(),
  },
  startProxy: startEgressProxy,
  spawn: (file, args, env) =>
    spawn(resolveSandboxShellExecutable(file), args, {
      cwd: '/',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Stay in the host's process group: main signals that whole group, so a
      // killed host cannot leave the confined downloader running.
      detached: false,
    }),
  nodePath: process.execPath,
  downloaderPath: join(__dirname, ARTIFACT_IMAGE_DOWNLOADER_BUNDLE),
  runtimeReadPaths: electronRuntimeAllowReadPaths(),
  log: (line) => {
    process.stderr.write(`${line}\n`)
  },
}

const abort = new AbortController()
/** After cancellation, teardown gets this long before the host exits anyway. */
const CANCEL_EXIT_GRACE_MS = 3_000

async function main(): Promise<void> {
  const job = await new Promise<HostJob | null>((resolve) => {
    let received = false
    const splitter = new BoundedLineSplitter(
      (line) => {
        if (received) return
        received = true
        resolve(decodeLine(line, zHostJob))
      },
      () => {
        if (!received) resolve(null)
        received = true
      },
    )
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      splitter.push(chunk)
    })
    // The parent closing stdin (or dying) cancels whatever is running.
    process.stdin.once('end', () => {
      if (!received) resolve(null)
      received = true
      abort.abort()
    })
  })
  if (!job) {
    process.exitCode = 2
    return
  }
  await runArtifactImageHostJob(
    job,
    dependencies,
    (frame) => {
      process.stdout.write(encodeFrame(frame))
    },
    abort.signal,
  )
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    // Cancel through the normal path, which kills the child and resets ASRT.
    abort.abort()
    setTimeout(() => {
      process.exit(1)
    }, CANCEL_EXIT_GRACE_MS).unref()
  })
}

void main().then(
  () => {
    process.stdout.write('', () => {
      process.exit()
    })
  },
  () => {
    process.exit(1)
  },
)
