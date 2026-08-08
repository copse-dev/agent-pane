import { join } from 'node:path'
import { dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { MAX_FS_WRITE_BYTES } from '../ipc/ipc-guards.ts'
import {
  assertWorkspaceWriteTarget,
  assertWriteTargetWithinRoot,
  getWorkspaceRoot,
} from '../services/workspace.ts'
import {
  getActiveExecutionTarget,
  isSshExecutionTarget,
} from '../services/ssh-workspace/execution-target.ts'
import { getActiveWorkspaceFs } from '../services/workspace-fs/get-workspace-fs.ts'
import { runCommand } from '../services/exec/command-runner.ts'
import { fsWorkerSandboxOverlay } from './config.ts'
import { isProjectSandboxEnabled } from './spawn.ts'
import {
  requestViaServer,
  SandboxFsServerUnavailable,
  shutdownSandboxFsServer,
} from './sandbox-fs-server.ts'
import { isRecord, parseJsonUnknown } from '@shared/unknown-value.ts'

/** JSON-wrapped readFile payloads can be ~2× raw bytes when heavily escaped. */
export const SANDBOX_FS_WORKER_STDOUT_MAX_BYTES = MAX_FS_WRITE_BYTES * 2 + 4096

let workerBundleVerified = false

/**
 * Bundled next to `dist/main/index.js`.
 *
 * Checked rather than assumed, because the worker is reached by path from a
 * child process: when the bundle was missing (a `dist/` built only by
 * `npm run dev`, which until recently never emitted it) the sole evidence was a
 * `MODULE_NOT_FOUND` stack printed by a spawned Electron, arriving as the
 * *message* of an `fs:listDir` rejection with nothing naming the build. Worse,
 * every call paid for it twice — the persistent server's worker, then the
 * one-shot fallback — so a single file-tree walk launched dozens of processes
 * that each died on startup, stalling the main loop. Failing here costs one
 * `existsSync` and says what to run.
 *
 * Only success is cached: a dev rebuild that finally emits the bundle recovers
 * without restarting the app.
 */
export function sandboxFsWorkerPath(): string {
  const path = join(__dirname, 'sandbox-fs-worker.js')
  if (workerBundleVerified) return path
  if (!existsSync(path)) {
    throw new Error(
      `sandbox fs worker bundle is missing at ${path} — ` +
        'run `npm run build`, or restart `npm run dev`, to emit it',
    )
  }
  workerBundleVerified = true
  return path
}

/** Passed via spawn env when the worker is launched through a shell / ASRT wrap (paths may contain spaces). */
export const SANDBOX_FS_REQUEST_ENV = 'COPSE_SANDBOX_FS_REQUEST'

type OneShotInvoker = (
  request: Record<string, unknown>,
  requestedRoot?: string,
) => Promise<Record<string, unknown>>

let oneShotInvokerForTest: OneShotInvoker | null = null
let sandboxFsGatewayEnabledForTest: boolean | null = null

export function setSandboxFsOneShotInvokerForTest(fn: OneShotInvoker | null): void {
  oneShotInvokerForTest = fn
}

export function setSandboxFsGatewayEnabledForTest(value: boolean | null): void {
  sandboxFsGatewayEnabledForTest = value
}

/**
 * Report a gateway op the sandbox would not serve, naming the path and the root
 * the worker was confined to.
 *
 * The filesystem counterpart of {@link recordNetworkDenial}: ASRT's own error
 * does not say which path it refused, and the two list ops below degrade to an
 * empty array rather than throwing — so a denied directory reaches the UI as
 * "this folder is empty", which is indistinguishable from an actually empty
 * folder and leaves nothing to debug. A confinement mismatch (a thread worktree
 * outside the root the worker was given, say) is invisible without this.
 */
const GATEWAY_DENIAL_LOG_LIMIT = 20
let gatewayDenialsLogged = 0

function reportGatewayDenial(
  op: string,
  path: string,
  root: string | undefined,
  detail: string,
): void {
  // Bounded: a single file-tree walk against a confined worker can refuse every
  // entry, and this sits in that hot path. Unbounded it would emit thousands of
  // lines through the main-process stdout the e2e harness reads — enough to
  // matter for run time, and enough to bury the first denial, which is the one
  // that identifies the boundary. The first few name the mismatch; the rest add
  // nothing a reader would act on.
  if (gatewayDenialsLogged >= GATEWAY_DENIAL_LOG_LIMIT) return
  gatewayDenialsLogged += 1
  const more =
    gatewayDenialsLogged === GATEWAY_DENIAL_LOG_LIMIT ? ' (further denials suppressed)' : ''
  console.warn(
    `[sandbox-fs] ${op} refused for ${JSON.stringify(path)} ` +
      `(worker root ${JSON.stringify(root ?? getWorkspaceRoot() ?? '(none)')}): ${detail}${more}`,
  )
}

async function invokeWorker(
  request: Record<string, unknown>,
  root?: string,
): Promise<Record<string, unknown>> {
  const invokeOneShot = oneShotInvokerForTest ?? invokeWorkerOneShot
  if (request['op'] === 'writeFile') {
    // A writable Linux bwrap worker creates host mount points for mandatory
    // deny paths. Stop the persistent read worker first so ASRT can clean those
    // mounts as soon as this short-lived write worker exits.
    shutdownSandboxFsServer()
    return invokeOneShot(request, root)
  }
  // Prefer the long-lived worker (no per-call process spawn). Only transport failures fall
  // back to a one-shot spawn; a `{ ok: false }` filesystem error is surfaced as-is.
  try {
    const res = await requestViaServer(request, root)
    assertWorkerOk(res)
    return res
  } catch (err) {
    if (!(err instanceof SandboxFsServerUnavailable)) {
      const op = typeof request['op'] === 'string' ? request['op'] : 'fs'
      const path = typeof request['path'] === 'string' ? request['path'] : '(no path)'
      reportGatewayDenial(op, path, root, err instanceof Error ? err.message : String(err))
      throw err
    }
  }
  return invokeOneShot(request, root)
}

function assertWorkerOk(parsed: { ok: boolean; error?: string }): void {
  if (!parsed.ok) {
    throw new Error(parsed.error ?? 'sandbox fs worker failed')
  }
}

async function invokeWorkerOneShot(
  request: Record<string, unknown>,
  requestedRoot?: string,
): Promise<Record<string, unknown>> {
  const root = requestedRoot ?? getWorkspaceRoot()
  if (!root) throw new Error('No workspace open. Use Open Folder first.')

  const workerPath = sandboxFsWorkerPath()
  const requestJson = JSON.stringify(request)
  const sandboxed = useSandboxFsGateway()
  const { stdout, stderr, code } = await runCommand(
    process.execPath,
    sandboxed ? [workerPath] : [workerPath, requestJson],
    {
      cwd: root,
      // Electron must run as Node inside seatbelt; otherwise MachPort rendezvous FATALs with empty stdout.
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ...(sandboxed ? { [SANDBOX_FS_REQUEST_ENV]: requestJson } : {}),
      },
      stdoutMaxBytes: SANDBOX_FS_WORKER_STDOUT_MAX_BYTES,
      sandboxConfig: fsWorkerSandboxOverlay(root, workerPath),
    },
  )

  if (code !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `sandbox fs worker exited ${String(code)}`)
  }

  let parsed: Record<string, unknown>
  try {
    const value = parseJsonUnknown(stdout.trim())
    if (!isRecord(value) || typeof value['ok'] !== 'boolean') {
      throw new TypeError('invalid response')
    }
    parsed = value
  } catch {
    const detail = stderr.trim() || stdout.trim() || '(empty output)'
    throw new Error(`sandbox fs worker returned invalid JSON: ${detail.slice(0, 200)}`)
  }

  const ok = parsed['ok']
  if (typeof ok !== 'boolean') throw new Error('sandbox fs worker returned an invalid response')
  const error = parsed['error']
  assertWorkerOk({ ok, ...(typeof error === 'string' ? { error } : {}) })
  return parsed
}

function useSandboxFsGateway(): boolean {
  if (sandboxFsGatewayEnabledForTest !== null) return sandboxFsGatewayEnabledForTest
  if (isSshExecutionTarget(getActiveExecutionTarget())) return false
  return isProjectSandboxEnabled()
}

export async function gatewayReadFile(absPath: string, root?: string): Promise<string> {
  if (!useSandboxFsGateway()) {
    return getActiveWorkspaceFs().readFile(absPath, 'utf-8')
  }
  const res = await invokeWorker({ op: 'readFile', path: absPath, encoding: 'utf-8' }, root)
  if (typeof res['data'] !== 'string') throw new Error('readFile: missing data')
  return res['data']
}

export async function gatewayWriteFile(
  absPath: string,
  content: string,
  root?: string,
): Promise<void> {
  // Guard the write target against symlink escape before any mkdir/writeFile
  // follows it (#578). `resolveWorkspacePath` only realpaths a path's existing
  // prefix, so a repo shipping a *dangling* symlink (target not yet on disk) is
  // treated as a plain new file and a write would follow it outside the root.
  // The diff-queue write path already asserts this; the `fs:writeFile` IPC path
  // reaches the filesystem through here, so guarding at this chokepoint covers
  // both the direct-fs and sandbox-worker branches below.
  if (root) await assertWriteTargetWithinRoot(absPath, root)
  else await assertWorkspaceWriteTarget(absPath)
  if (!useSandboxFsGateway()) {
    const fs = getActiveWorkspaceFs()
    await fs.mkdir(dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, content, 'utf-8')
    return
  }
  await invokeWorker({ op: 'writeFile', path: absPath, content, encoding: 'utf-8' }, root)
}

export async function gatewayReaddir(absPath: string, root?: string): Promise<string[]> {
  if (!useSandboxFsGateway()) {
    return getActiveWorkspaceFs().readdir(absPath)
  }
  const res = await invokeWorker({ op: 'readdir', path: absPath }, root)
  if (!Array.isArray(res['entries'])) {
    reportGatewayDenial('readdir', absPath, root, 'worker returned no entries')
    return []
  }
  return res['entries'].filter((entry): entry is string => typeof entry === 'string')
}

export async function gatewayListDir(
  absPath: string,
  root?: string,
): Promise<{ name: string; isDir: boolean }[]> {
  if (!useSandboxFsGateway()) {
    return getActiveWorkspaceFs().readdirWithTypes(absPath)
  }
  const res = await invokeWorker({ op: 'statDir', path: absPath }, root)
  if (!Array.isArray(res['dirents'])) {
    reportGatewayDenial('statDir', absPath, root, 'worker returned no dirents')
    return []
  }
  return res['dirents'].flatMap((entry) =>
    isRecord(entry) && typeof entry['name'] === 'string' && typeof entry['isDir'] === 'boolean'
      ? [{ name: entry['name'], isDir: entry['isDir'] }]
      : [],
  )
}
