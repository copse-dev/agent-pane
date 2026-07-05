import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { baseSandboxConfig } from './config.ts'
import { recordNetworkDenial } from './network-scope.ts'
import { setProjectSandboxEnabled } from './spawn.ts'
import { shutdownSandboxFsServer } from './sandbox-fs-server.ts'

export {
  spawnInProjectSandbox,
  spawnShellInProjectSandbox,
  spawnPtyInProjectSandbox,
  spawnBackgroundProcess,
  afterSandboxedCommand,
  isProjectSandboxEnabled,
  sandboxViolationCountForCommand,
} from './spawn.ts'
export {
  gatewayReadFile,
  gatewayWriteFile,
  gatewayReaddir,
  gatewayListDir,
} from './sandbox-fs-client.ts'

/**
 * Start Anthropic Sandbox Runtime for macOS project subprocesses (shell, git, rg, indexer).
 * No-op on non-macOS; falls back to unsandboxed spawns if init fails.
 *
 * Subprocesses inherit seatbelt filesystem rules from {@link workspaceSandboxOverlay}.
 * When ASRT is active, renderer `fs:*` IPC is served by {@link sandbox-fs-client}
 * (seatbelt-wrapped Node worker). `fs.watch` still uses main-process watchers; content
 * reloads go through the same gateway.
 */
export async function initProjectSandbox(): Promise<void> {
  if (process.platform !== 'darwin') {
    setProjectSandboxEnabled(false)
    return
  }

  try {
    // The ask-callback fires for each connection that misses the allowlist.
    // We never grant from it (return false keeps the deny) — it exists to
    // RECORD the blocked host:port, which ASRT's own 403 body doesn't name,
    // so allowlist gaps are debuggable (e.g. the ACP turn's network audit).
    await SandboxManager.initialize(
      baseSandboxConfig(),
      ({ host, port }) => {
        recordNetworkDenial(host, port)
        console.warn(`[project-sandbox] network denied: ${host}:${String(port ?? '?')}`)
        return Promise.resolve(false)
      },
      false,
    )
    setProjectSandboxEnabled(true)
    console.log('[project-sandbox] macOS seatbelt active (ASRT)')
  } catch (err) {
    setProjectSandboxEnabled(false)
    console.warn('[project-sandbox] ASRT init failed — project commands run unsandboxed:', err)
  }
}

export async function shutdownProjectSandbox(): Promise<void> {
  shutdownSandboxFsServer()
  if (SandboxManager.isSandboxingEnabled()) {
    await SandboxManager.reset()
  }
  setProjectSandboxEnabled(false)
}
