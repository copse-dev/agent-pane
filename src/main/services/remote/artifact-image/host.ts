/**
 * Trusted per-download host (docs/plans/sandboxed-artifact-image-downloads.md).
 *
 * One host handles exactly one job. It owns its own ASRT manager, so the
 * download's network scope never touches the Electron main process's shared
 * allowlist, and its own egress proxy, so the allowlist and proxy token are
 * never shared with another job. The host itself is not sandboxed — calling
 * `SandboxManager.initialize` does not confine the caller — it only confines
 * the downloader child it starts.
 */
import { randomBytes } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { signalProcessTree } from '@copse/std/process-tree.ts'
import type { EgressDecision, EgressProxy, EgressProxyOptions } from './egress-proxy.ts'
import {
  ARTIFACT_IMAGE_DOWNLOAD_DEADLINE_MS,
  ArtifactImageError,
  canonicalDownloadOrigin,
  checkDownloadUrl,
  type ArtifactImageErrorCode,
} from './policy.ts'
import {
  BoundedLineSplitter,
  decodeLine,
  encodeFrame,
  errorFrame,
  imageFrames,
  ImageFrameAssembler,
  zImageFrame,
  type HostJob,
  type ImageFrame,
} from './protocol.ts'

/** Startup plus the downloader's own deadline, so the child times out first. */
export const ARTIFACT_IMAGE_HOST_DEADLINE_MS = ARTIFACT_IMAGE_DOWNLOAD_DEADLINE_MS + 10_000
const CHILD_KILL_GRACE_MS = 1_000

export interface HostSandbox {
  initialize(config: SandboxRuntimeConfig): Promise<void>
  /** argv and env for running `command` inside the initialized sandbox. */
  wrap(command: string): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
  reset(): Promise<void>
}

export interface HostDependencies {
  sandbox: HostSandbox
  startProxy(options: EgressProxyOptions): Promise<EgressProxy>
  spawn(file: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess
  /** Absolute runtime and bundle; never taken from the job. */
  nodePath: string
  downloaderPath: string
  /** Runtime paths the downloader must read to start (Electron/Node, ASRT helpers). */
  runtimeReadPaths: readonly string[]
  /** Defaults to {@link ARTIFACT_IMAGE_HOST_DEADLINE_MS}. */
  deadlineMs?: number
  log?: (line: string) => void
}

/**
 * Roots the downloader may not read. This is a denylist over a readable system,
 * so it names every place user or project data commonly lives, not only home;
 * the runtime and ASRT helper paths under them are re-allowed explicitly.
 */
const DATA_ROOTS = [
  '/root',
  '/home',
  '/Users',
  '/Volumes',
  '/workspace',
  '/workspaces',
  '/srv',
  '/opt',
  '/mnt',
  '/media',
  '/data',
  '/private/tmp',
]

function protectedReadRoots(): string[] {
  const roots = new Set([homedir(), tmpdir(), ...DATA_ROOTS])
  if (process.platform === 'darwin') roots.add('/private/var/folders')
  return [...roots]
}

/**
 * The download-specific sandbox profile. Not a project overlay: no workspace,
 * no home or temp reads, no writes, no local binding and no Unix sockets. The
 * only network route is ASRT's bridge to this job's proxy (both HTTP and SOCKS
 * point at it, so no ASRT-owned proxy exists to fall through to).
 */
export function downloaderSandboxConfig(input: {
  proxyPort: number
  allowedHosts: readonly string[]
  downloaderPath: string
  runtimeReadPaths: readonly string[]
}): SandboxRuntimeConfig {
  const downloaderDir = dirname(resolve(input.downloaderPath))
  return {
    network: {
      allowedDomains: [...input.allowedHosts],
      deniedDomains: [],
      allowLocalBinding: false,
      allowAllUnixSockets: false,
      allowUnixSockets: [],
      httpProxyPort: input.proxyPort,
      socksProxyPort: input.proxyPort,
    },
    filesystem: {
      denyRead: protectedReadRoots(),
      allowRead: [downloaderDir, `${downloaderDir}/**`, ...input.runtimeReadPaths],
      allowWrite: [],
      denyWrite: [],
      allowGitConfig: false,
    },
  }
}

/**
 * Built from scratch, not filtered: ASRT bakes its proxy variables into argv on
 * both platforms, so the child needs only enough to find the sandbox wrapper
 * and run Electron as Node. No tokens, `NODE_OPTIONS`, CA overrides, proxy
 * bypasses or user startup files can reach it.
 */
export function downloaderEnv(wrapperEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: wrapperEnv['PATH'] ?? '/usr/bin:/bin',
    ELECTRON_RUN_AS_NODE: '1',
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The hostnames of `origins`, or null when any is not an approvable origin. */
export function approvedHosts(origins: readonly string[]): string[] | null {
  const hosts: string[] = []
  for (const origin of origins) {
    const canonical = canonicalDownloadOrigin(origin)
    if (canonical !== origin) return null
    hosts.push(new URL(canonical).hostname)
  }
  return hosts
}

function decisionLog(decision: EgressDecision): string {
  return `[artifact-image-host] egress ${decision.outcome}${decision.host ? ` ${decision.host}` : ''}`
}

/**
 * Run one job: proxy, sandbox, confined downloader, independent verification.
 * Emits exactly one terminal frame sequence (chunks + done, or one error) and
 * always tears down the child tree, proxy and ASRT manager before resolving.
 */
export async function runArtifactImageHostJob(
  job: HostJob,
  dependencies: HostDependencies,
  emit: (frame: ImageFrame) => void,
  signal: AbortSignal,
): Promise<void> {
  const log = dependencies.log ?? ((): void => {})
  const fail = (code: ArtifactImageErrorCode, origin?: string): void => {
    emit(errorFrame(job.requestId, code, origin))
  }
  const hosts = approvedHosts(job.approvedOrigins)
  if (!hosts) {
    fail('protocol')
    return
  }
  try {
    checkDownloadUrl(job.url, job.approvedOrigins)
  } catch (error) {
    const failure = error instanceof ArtifactImageError ? error : null
    fail(failure?.code ?? 'origin-denied', failure?.origin)
    return
  }

  const token = randomBytes(32).toString('hex')
  let proxy: EgressProxy | null = null
  let sandboxStarted = false
  let child: ChildProcess | null = null
  try {
    try {
      proxy = await dependencies.startProxy({
        token,
        allowedHosts: hosts,
        onDecision: (decision) => {
          log(decisionLog(decision))
        },
      })
    } catch {
      // Without its proxy the downloader has no route at all; never start it.
      fail('sandbox-unavailable')
      return
    }
    try {
      await dependencies.sandbox.initialize(
        downloaderSandboxConfig({
          proxyPort: proxy.port,
          allowedHosts: hosts,
          downloaderPath: dependencies.downloaderPath,
          runtimeReadPaths: dependencies.runtimeReadPaths,
        }),
      )
      sandboxStarted = true
    } catch {
      // No unsandboxed fallback: the image simply stays unavailable.
      fail('sandbox-unavailable')
      return
    }
    let wrapped: { argv: string[]; env: NodeJS.ProcessEnv }
    try {
      wrapped = await dependencies.sandbox.wrap(
        `${shellQuote(dependencies.nodePath)} ${shellQuote(dependencies.downloaderPath)}`,
      )
    } catch {
      fail('sandbox-unavailable')
      return
    }
    const [file, ...args] = wrapped.argv
    if (!file) {
      fail('sandbox-unavailable')
      return
    }
    const spawned = dependencies.spawn(file, args, downloaderEnv(wrapped.env))
    child = spawned
    await relayDownloader(
      spawned,
      { ...job, proxyToken: token },
      emit,
      signal,
      dependencies.deadlineMs ?? ARTIFACT_IMAGE_HOST_DEADLINE_MS,
    )
  } finally {
    if (child) await stopChild(child)
    await proxy?.close()
    if (sandboxStarted) await dependencies.sandbox.reset().catch(() => {})
  }
}

/**
 * Resolves once the child has actually exited, so the proxy and ASRT manager
 * are never torn down under a still-running downloader. SIGKILL follows a
 * grace period; a final bound keeps a wedged process from hanging the host.
 */
function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolveStop) => {
    const finish = (): void => {
      clearTimeout(killTimer)
      clearTimeout(giveUpTimer)
      resolveStop()
    }
    const killTimer = setTimeout(() => {
      signalProcessTree(child, 'SIGKILL')
    }, CHILD_KILL_GRACE_MS)
    const giveUpTimer = setTimeout(finish, CHILD_KILL_GRACE_MS * 3)
    child.once('close', finish)
    signalProcessTree(child, 'SIGTERM')
  })
}

/**
 * Feed the job to the downloader and verify everything it sends back before
 * relaying. Only a fully verified image is re-framed for main; anything else
 * becomes one bounded error code.
 */
function relayDownloader(
  child: ChildProcess,
  job: HostJob & { proxyToken: string },
  emit: (frame: ImageFrame) => void,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<void> {
  return new Promise((resolveRelay) => {
    const assembler = new ImageFrameAssembler(job.requestId)
    let finished = false
    const finish = (frames: ImageFrame[]): void => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      signal.removeEventListener('abort', onAbort)
      for (const frame of frames) emit(frame)
      resolveRelay()
    }
    const failWith = (code: ArtifactImageErrorCode, origin?: string): void => {
      finish([errorFrame(job.requestId, code, origin)])
    }
    const onAbort = (): void => {
      failWith('cancelled')
    }
    const deadline = setTimeout(() => {
      failWith('timeout')
    }, deadlineMs)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }

    const splitter = new BoundedLineSplitter(
      (line) => {
        if (finished) return
        const frame = decodeLine(line, zImageFrame)
        if (!frame) {
          failWith('protocol')
          return
        }
        try {
          const image = assembler.accept(frame)
          if (image) finish(imageFrames(job.requestId, image.mime, image.bytes))
        } catch (error) {
          const failure = error instanceof ArtifactImageError ? error : null
          failWith(failure?.code ?? 'protocol', failure?.origin)
        }
      },
      () => {
        failWith('protocol')
      },
    )
    child.stdout?.setEncoding('utf8')
    let sawOutput = false
    child.stdout?.on('data', (chunk: string) => {
      sawOutput = true
      splitter.push(chunk)
    })
    // Bounded drain: the downloader's stderr is not trusted output.
    child.stderr?.resume()
    child.once('error', () => {
      failWith('sandbox-unavailable')
    })
    child.once('close', () => {
      // A running downloader always answers with a frame, even to fail. Silence
      // means the sandbox itself never started (bubblewrap refused by a
      // user-namespace restriction, say), which retrying cannot fix. Exiting
      // after some output but before a verified completion is incomplete.
      failWith(sawOutput ? 'protocol' : 'sandbox-unavailable')
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(encodeFrame(job))
  })
}
