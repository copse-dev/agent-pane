import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { baseSandboxConfig } from './config.ts'
import { setProjectSandboxEnabled } from './spawn.ts'
import { shutdownSandboxFsServer } from './sandbox-fs-server.ts'

export {
  spawnInProjectSandbox,
  spawnShellInProjectSandbox,
  spawnPtyInProjectSandbox,
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
    await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
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
