import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { baseSandboxConfig } from './config.ts'
import { recordNetworkDenial } from './network-scope.ts'
import { setProjectSandboxEnabled } from './spawn.ts'
import { shutdownSandboxFsServer } from './sandbox-fs-server.ts'
import { reapOrphanedSandboxBridges } from './orphaned-bridges.ts'
import { isProjectSandboxPlatform, setProjectSandboxInitFailure } from './state.ts'

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
 * Start Anthropic Sandbox Runtime for project subprocesses (shell, git, rg, indexer)
 * on every platform with an ASRT backend — `sandbox-exec` on macOS, `bubblewrap`
 * on Linux. No-op elsewhere; falls back to unsandboxed spawns if init fails.
 *
 * Subprocesses inherit filesystem rules from {@link workspaceSandboxOverlay}.
 * When ASRT is active, renderer `fs:*` IPC is served by {@link sandbox-fs-client}
 * (a sandboxed Node worker). `fs.watch` still uses main-process watchers; content
 * reloads go through the same gateway.
 *
 * Linux needs `bubblewrap` on PATH *and* usable unprivileged user namespaces.
 * Where either is missing (a locked-down container, say) `initialize` throws and
 * we degrade to unsandboxed exactly as before — with one consequence worth
 * knowing: executable pack behavior fails closed without a sandbox, so packs
 * stay unavailable rather than running unconfined (see pack-tool-host.ts).
 */
export async function initProjectSandbox(): Promise<void> {
  if (!isProjectSandboxPlatform()) {
    setProjectSandboxEnabled(false)
    return
  }

  // Reclaim bridges left by a previous run that never reached `before-quit`.
  // Startup is the reliable moment for this: whatever killed the last process
  // could not be counted on to clean up after it, and a machine that hosts many
  // runs back to back (a CI runner, a dev box) otherwise only ever accumulates.
  const reaped = reapOrphanedSandboxBridges()
  if (reaped.length > 0) {
    console.log(`[project-sandbox] reaped ${String(reaped.length)} orphaned ASRT network bridge(s)`)
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
    setProjectSandboxInitFailure(undefined)
    console.log(
      `[project-sandbox] ${
        process.platform === 'darwin' ? 'macOS seatbelt' : 'Linux bubblewrap'
      } active (ASRT)`,
    )
  } catch (err) {
    setProjectSandboxEnabled(false)
    setProjectSandboxInitFailure(err instanceof Error ? err.message : String(err))
    console.warn('[project-sandbox] ASRT init failed — project commands run unsandboxed:', err)
  }
}

export async function shutdownProjectSandbox(): Promise<void> {
  shutdownSandboxFsServer()
  if (SandboxManager.isSandboxingEnabled()) {
    await SandboxManager.reset()
  }
  // `reset()` kills the bridge it is holding, but only the one this manager
  // knows about. Sweep again so a bridge orphaned mid-session (ASRT re-inited,
  // or reset() bailed before reaching it) does not outlive us either.
  reapOrphanedSandboxBridges()
  setProjectSandboxEnabled(false)
}
