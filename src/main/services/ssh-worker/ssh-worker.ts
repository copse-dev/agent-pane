import { localSocketPath } from '../local-socket.ts'
import type { SshConnection } from '../ssh-workspace/connection-manager.ts'
import { getSshConnectionManager } from '../ssh-workspace/connection-manager.ts'
import {
  connectTurnHost,
  TURN_HOST_PROTOCOL,
  type HostToApp,
} from '../turn-host/turn-host-protocol.ts'
import { NO_CAPABILITIES, type WorkerCapabilities } from '../worker-protocol/worker-capabilities.ts'
import { buildSshWorkerPackage, type SshWorkerPackage } from './ssh-worker-package.ts'
import {
  approveSshWorkerInstall,
  formatSshWorkerInstallApproval,
} from './ssh-worker-install-approval.ts'
import {
  installDir,
  installedArgv,
  MIN_NODE,
  nodeIsRecentEnough,
  parseRemoteNode,
  probeNodeArgv,
  startArgv,
  unpackArgv,
} from './ssh-worker-remote.ts'

/**
 * Start the Copse worker on an SSH host and reach it from here
 * (`docs/plans/harness-worker-roadmap.md`, R3).
 *
 * Over the host's existing connection: check the host's Node, ask the user
 * once per app run, upload this build's worker when the host lacks it, start
 * it detached, and forward a local socket to the one it serves over the same
 * ControlMaster. The app then speaks the worker protocol on that socket as it
 * does to the local turn host.
 */

export interface SshWorkerDependencies {
  /** This app's version; the worker reports it back in its hello. */
  version: string
  /** The app's profile, under which the local end of the forward lives. */
  userDataPath: string
  connection: (hostId: string) => SshConnection | null
  approve: (hostLabel: string) => Promise<boolean>
  /** This build's worker, packed (`ssh-worker-package.ts`). */
  workerPackage: () => SshWorkerPackage
}

export type SshWorkerStart =
  | { ok: true; localSocket: string; remoteSocket: string; uploaded: boolean }
  | { ok: false; reason: string }

let cachedPackage: SshWorkerPackage | null = null

export function defaultSshWorkerDependencies(
  version: string,
  userDataPath: string,
): SshWorkerDependencies {
  return {
    version,
    userDataPath,
    connection: (hostId) => getSshConnectionManager().getConnection(hostId),
    approve: (hostLabel) => approveSshWorkerInstall(formatSshWorkerInstallApproval(hostLabel)),
    workerPackage: () => (cachedPackage ??= buildSshWorkerPackage()),
  }
}

/** Hosts the user let run the worker in this app run. */
const approvedHosts = new Set<string>()

export function forgetSshWorkerApprovals(): void {
  approvedHosts.clear()
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-5).join('\n')
}

export async function startSshWorker(
  hostId: string,
  deps: SshWorkerDependencies,
): Promise<SshWorkerStart> {
  const connection = deps.connection(hostId)
  if (connection === null) return { ok: false, reason: 'the host is not connected' }

  const probe = await connection.execArgv(probeNodeArgv(), { timeoutMs: 30_000 })
  const node = probe.code === 0 ? parseRemoteNode(probe.stdout) : null
  if (node === null) return { ok: false, reason: `the host has no Node ${MIN_NODE} or later` }
  if (!nodeIsRecentEnough(node.version))
    return {
      ok: false,
      reason: `the host's Node is ${node.version}; the worker needs ${MIN_NODE} or later`,
    }

  if (!approvedHosts.has(hostId)) {
    if (!(await deps.approve(connection.host.label)))
      return { ok: false, reason: 'the user kept turns on this computer' }
    approvedHosts.add(hostId)
  }

  const worker = deps.workerPackage()
  const dir = installDir(node, worker.id)
  const present = await connection.execArgv(installedArgv(dir), { timeoutMs: 30_000 })
  const uploaded = present.code !== 0
  if (uploaded) {
    const unpack = await connection.execArgv(unpackArgv(node, dir, worker.hash), {
      stdin: worker.archive.toString('base64'),
      timeoutMs: 300_000,
    })
    if (unpack.code !== 0)
      return { ok: false, reason: `the upload failed: ${tail(unpack.stderr) || 'no output'}` }
  }

  const started = await connection.execArgv(startArgv(node, dir, deps.version), {
    timeoutMs: 60_000,
  })
  const remoteSocket = started.stdout.trim().split('\n').at(-1) ?? ''
  if (started.code !== 0 || !remoteSocket.startsWith('/'))
    return { ok: false, reason: `the worker did not start: ${tail(started.stderr) || 'no output'}` }

  const localSocket = localSocketPath(deps.userDataPath, 'ssh-worker', hostId)
  try {
    await connection.transport.openSocketForward(localSocket, remoteSocket)
  } catch (error) {
    return { ok: false, reason: `could not reach the worker: ${String(error)}` }
  }
  return { ok: true, localSocket, remoteSocket, uploaded }
}

export async function stopSshWorkerForward(
  hostId: string,
  deps: Pick<SshWorkerDependencies, 'connection' | 'userDataPath'>,
): Promise<void> {
  await deps
    .connection(hostId)
    ?.transport.closeSocketForward(localSocketPath(deps.userDataPath, 'ssh-worker', hostId))
}

/** The worker's hello over the forward: its version and what it can run. */
export async function sshWorkerHello(
  localSocket: string,
  version: string,
): Promise<{ version: string; pid: number; capabilities: WorkerCapabilities } | null> {
  const hello = Promise.withResolvers<Extract<HostToApp, { t: 'hello' }> | null>()
  const line = await connectTurnHost(
    localSocket,
    (message) => {
      if (message.t === 'hello') hello.resolve(message)
    },
    () => {
      hello.resolve(null)
    },
  )
  if (line === null) return null
  try {
    line.send({ t: 'hello', version, protocol: TURN_HOST_PROTOCOL })
    // A worker answers hello at once; one that does not is not one.
    const timer = setTimeout(() => {
      hello.resolve(null)
    }, 10_000)
    const answer = await hello.promise
    clearTimeout(timer)
    if (answer === null) return null
    return {
      version: answer.version,
      pid: answer.pid,
      capabilities: answer.capabilities ?? NO_CAPABILITIES,
    }
  } finally {
    line.close()
  }
}
