import { join } from 'node:path'
import { dirname } from 'node:path'
import { MAX_FS_WRITE_BYTES } from '../ipc/ipc-guards.ts'
import { assertWorkspaceWriteTarget, getWorkspaceRoot } from '../services/workspace.ts'
import {
  getActiveExecutionTarget,
  isSshExecutionTarget,
} from '../services/ssh-workspace/execution-target.ts'
import { getActiveWorkspaceFs } from '../services/workspace-fs/get-workspace-fs.ts'
import { runCommand } from '../services/exec/command-runner.ts'
import { fsWorkerSandboxOverlay } from './config.ts'
import { isProjectSandboxEnabled } from './spawn.ts'
import { requestViaServer, SandboxFsServerUnavailable } from './sandbox-fs-server.ts'

/** JSON-wrapped readFile payloads can be ~2× raw bytes when heavily escaped. */
export const SANDBOX_FS_WORKER_STDOUT_MAX_BYTES = MAX_FS_WRITE_BYTES * 2 + 4096

/** Bundled next to `dist/main/index.js`. */
export function sandboxFsWorkerPath(): string {
  return join(__dirname, 'sandbox-fs-worker.js')
}

/** Passed via spawn env when the worker is launched through a shell / ASRT wrap (paths may contain spaces). */
export const SANDBOX_FS_REQUEST_ENV = 'COPSE_SANDBOX_FS_REQUEST'

async function invokeWorker<T extends Record<string, unknown>>(
  request: Record<string, unknown>,
): Promise<T> {
  // Prefer the long-lived worker (no per-call process spawn). Only transport failures fall
  // back to a one-shot spawn; a `{ ok: false }` filesystem error is surfaced as-is.
  try {
    const res = await requestViaServer(request)
    assertWorkerOk(res)
    return res as T
  } catch (err) {
    if (!(err instanceof SandboxFsServerUnavailable)) throw err
  }
  return invokeWorkerOneShot<T>(request)
}

function assertWorkerOk(parsed: { ok: boolean; error?: string }): void {
  if (!parsed.ok) {
    throw new Error(parsed.error ?? 'sandbox fs worker failed')
  }
}

async function invokeWorkerOneShot<T extends Record<string, unknown>>(
  request: Record<string, unknown>,
): Promise<T> {
  const root = getWorkspaceRoot()
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

  let parsed: { ok: boolean; error?: string } & T
  try {
    parsed = JSON.parse(stdout.trim()) as { ok: boolean; error?: string } & T
  } catch {
    const detail = stderr.trim() || stdout.trim() || '(empty output)'
    throw new Error(`sandbox fs worker returned invalid JSON: ${detail.slice(0, 200)}`)
  }

  assertWorkerOk(parsed)
  return parsed
}

function useSandboxFsGateway(): boolean {
  if (isSshExecutionTarget(getActiveExecutionTarget())) return false
  return isProjectSandboxEnabled()
}

export async function gatewayReadFile(absPath: string): Promise<string> {
  if (!useSandboxFsGateway()) {
    return getActiveWorkspaceFs().readFile(absPath, 'utf-8')
  }
  const res = await invokeWorker<{ data?: string }>({
    op: 'readFile',
    path: absPath,
    encoding: 'utf-8',
  })
  if (typeof res.data !== 'string') throw new Error('readFile: missing data')
  return res.data
}

export async function gatewayWriteFile(absPath: string, content: string): Promise<void> {
  // Guard the write target against symlink escape before any mkdir/writeFile
  // follows it (#578). `resolveWorkspacePath` only realpaths a path's existing
  // prefix, so a repo shipping a *dangling* symlink (target not yet on disk) is
  // treated as a plain new file and a write would follow it outside the root.
  // The diff-queue write path already asserts this; the `fs:writeFile` IPC path
  // reaches the filesystem through here, so guarding at this chokepoint covers
  // both the direct-fs and sandbox-worker branches below.
  await assertWorkspaceWriteTarget(absPath)
  if (!useSandboxFsGateway()) {
    const fs = getActiveWorkspaceFs()
    await fs.mkdir(dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, content, 'utf-8')
    return
  }
  await invokeWorker({ op: 'writeFile', path: absPath, content, encoding: 'utf-8' })
}

export async function gatewayReaddir(absPath: string): Promise<string[]> {
  if (!useSandboxFsGateway()) {
    return getActiveWorkspaceFs().readdir(absPath)
  }
  const res = await invokeWorker<{ entries?: string[] }>({ op: 'readdir', path: absPath })
  return res.entries ?? []
}

export async function gatewayListDir(absPath: string): Promise<{ name: string; isDir: boolean }[]> {
  if (!useSandboxFsGateway()) {
    return getActiveWorkspaceFs().readdirWithTypes(absPath)
  }
  const res = await invokeWorker<{ dirents?: { name: string; isDir: boolean }[] }>({
    op: 'statDir',
    path: absPath,
  })
  return res.dirents ?? []
}
