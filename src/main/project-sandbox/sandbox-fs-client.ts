import { join } from 'node:path'
import { dirname } from 'node:path'
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
import { requestViaServer, SandboxFsServerUnavailable } from './sandbox-fs-server.ts'
import { isRecord, parseJsonUnknown } from '@shared/unknown-value.ts'

/** JSON-wrapped readFile payloads can be ~2× raw bytes when heavily escaped. */
export const SANDBOX_FS_WORKER_STDOUT_MAX_BYTES = MAX_FS_WRITE_BYTES * 2 + 4096

/** Bundled next to `dist/main/index.js`. */
export function sandboxFsWorkerPath(): string {
  return join(__dirname, 'sandbox-fs-worker.js')
}

/** Passed via spawn env when the worker is launched through a shell / ASRT wrap (paths may contain spaces). */
export const SANDBOX_FS_REQUEST_ENV = 'COPSE_SANDBOX_FS_REQUEST'

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
function reportGatewayDenial(
  op: string,
  path: string,
  root: string | undefined,
  detail: string,
): void {
  console.warn(
    `[sandbox-fs] ${op} refused for ${JSON.stringify(path)} ` +
      `(worker root ${JSON.stringify(root ?? getWorkspaceRoot() ?? '(none)')}): ${detail}`,
  )
}

async function invokeWorker(
  request: Record<string, unknown>,
  root?: string,
): Promise<Record<string, unknown>> {
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
  return invokeWorkerOneShot(request, root)
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
