import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { baseSandboxConfig } from './config.ts'
import { setProjectSandboxEnabled } from './spawn.ts'

export {
  spawnInProjectSandbox,
  spawnShellInProjectSandbox,
  spawnPtyInProjectSandbox,
  afterSandboxedCommand,
  isProjectSandboxEnabled,
} from './spawn.ts'

/**
 * Start Anthropic Sandbox Runtime for macOS project subprocesses (shell, git, rg, indexer).
 * No-op on non-macOS; falls back to unsandboxed spawns if init fails.
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
  if (SandboxManager.isSandboxingEnabled()) {
    await SandboxManager.reset()
  }
  setProjectSandboxEnabled(false)
}
