import { join } from 'node:path'
import * as fsp from 'node:fs/promises'
import { dirname } from 'node:path'
import { MAX_FS_WRITE_BYTES } from '../ipc/ipc-guards.ts'
import { getWorkspaceRoot } from '../services/workspace.ts'
import { runCommand } from '../services/command-runner.ts'
import { fsWorkerSandboxOverlay } from './config.ts'
import { isProjectSandboxEnabled } from './spawn.ts'

/** JSON-wrapped readFile payloads can be ~2× raw bytes when heavily escaped. */
export const SANDBOX_FS_WORKER_STDOUT_MAX_BYTES = MAX_FS_WRITE_BYTES * 2 + 4096

/** Bundled next to `dist/main/index.js`. */
export function sandboxFsWorkerPath(): string {
  return join(__dirname, 'sandbox-fs-worker.js')
}

async function invokeWorker<T extends Record<string, unknown>>(
  request: Record<string, unknown>,
): Promise<T> {
  const root = getWorkspaceRoot()
  if (!root) throw new Error('No workspace open. Use Open Folder first.')

  const workerPath = sandboxFsWorkerPath()
  const { stdout, stderr, code } = await runCommand(
    process.execPath,
    [workerPath, JSON.stringify(request)],
    {
      cwd: root,
      // Electron must run as Node inside seatbelt; otherwise MachPort rendezvous FATALs with empty stdout.
      env: { ELECTRON_RUN_AS_NODE: '1' },
      stdoutMaxBytes: SANDBOX_FS_WORKER_STDOUT_MAX_BYTES,
      sandboxConfig: fsWorkerSandboxOverlay(root, workerPath),
    },
  )

  if (code !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `sandbox fs worker exited ${code}`)
  }

  let parsed: { ok: boolean; error?: string } & T
  try {
    parsed = JSON.parse(stdout.trim()) as { ok: boolean; error?: string } & T
  } catch {
    const detail = stderr.trim() || stdout.trim() || '(empty output)'
    throw new Error(`sandbox fs worker returned invalid JSON: ${detail.slice(0, 200)}`)
  }

  if (!parsed.ok) {
    throw new Error(parsed.error ?? 'sandbox fs worker failed')
  }

  return parsed
}

function useSandboxFsGateway(): boolean {
  return isProjectSandboxEnabled()
}

export async function gatewayReadFile(absPath: string): Promise<string> {
  if (!useSandboxFsGateway()) {
    return fsp.readFile(absPath, 'utf-8')
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
  if (!useSandboxFsGateway()) {
    await fsp.mkdir(dirname(absPath), { recursive: true })
    await fsp.writeFile(absPath, content, 'utf-8')
    return
  }
  await invokeWorker({ op: 'writeFile', path: absPath, content, encoding: 'utf-8' })
}

export async function gatewayReaddir(absPath: string): Promise<string[]> {
  if (!useSandboxFsGateway()) {
    return fsp.readdir(absPath)
  }
  const res = await invokeWorker<{ entries?: string[] }>({ op: 'readdir', path: absPath })
  return res.entries ?? []
}

export async function gatewayListDir(absPath: string): Promise<{ name: string; isDir: boolean }[]> {
  if (!useSandboxFsGateway()) {
    const dirents = await fsp.readdir(absPath, { withFileTypes: true })
    return dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }))
  }
  const res = await invokeWorker<{ dirents?: { name: string; isDir: boolean }[] }>({
    op: 'statDir',
    path: absPath,
  })
  return res.dirents ?? []
}
