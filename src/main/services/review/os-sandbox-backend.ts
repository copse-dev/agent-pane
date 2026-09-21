// The OS-sandbox isolation backend for Copse Reviewer (docs/plans/copse-reviewer.md,
// §Execution isolation, "Backend per shell — App"; binding decision B3).
//
// Adapts the app's project sandbox — ASRT's macOS seatbelt or Linux bubblewrap
// — to `@copse/review`'s `IsolationBackend`. The cell's processes may read and
// write their two checkouts and the scratch directory, read the declared
// read-only paths (the dependency store, the repository's git directory) and
// the Node toolchain, and nothing under the home directory; they get no
// network at all. Their environment is the one the orchestrator built, plus a
// `HOME` and `TMPDIR` inside the cell: ASRT's wrapper returns the host's
// `process.env` verbatim on POSIX, so this backend spawns the wrapped argv
// itself rather than going through `spawnInProjectSandbox`, which layers the
// app's own environment underneath the caller's.
//
// Process-scoped, so per B3 it is enough for the author's own tree and never
// for a foreign diff; `decideExecution` enforces that from `strength`.
import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type {
  CellCommand,
  CellCommandResult,
  CellSpec,
  ExecutionCell,
  IsolationBackend,
} from '@copse/review/isolation.ts'
import { collectProcess } from '@copse/review/process-collect.ts'
import {
  containedSandboxNetworkConfig,
  resolveNodeToolchainAllowRead,
  sandboxRuntimeHelperAllowReadPaths,
  workspaceMandatoryWriteDenyPaths,
} from '../../project-sandbox/config.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
// From `sandbox-argv.ts` rather than `spawn.ts`: the spawn module pulls in
// `node-pty` and the SSH transport, neither of which a review cell needs.
import {
  detachForGroupKill,
  formatArgvForShell,
  resolveSandboxShellExecutable,
  shellForSandboxWrap,
  withSandboxShellPath,
} from '../../project-sandbox/sandbox-argv.ts'

export const OS_SANDBOX_BACKEND_ID = 'os-sandbox'

function tree(root: string): string[] {
  return [root, `${root}/**`]
}

/**
 * The seatbelt overlay for one review cell. Pure in `spec` (plus the host's
 * platform and toolchain), so its shape is pinned by a unit test without a
 * live sandbox: writes only inside the checkouts and scratch, reads of the
 * home directory denied, no network.
 */
export function reviewCellSandboxOverlay(spec: CellSpec): Partial<SandboxRuntimeConfig> {
  const writable = [spec.checkouts.base, spec.checkouts.head, spec.scratchDir]
  const readOnly = [...spec.readOnlyPaths]
  const allowRead = [
    ...writable.flatMap(tree),
    ...readOnly.flatMap(tree),
    ...resolveNodeToolchainAllowRead(spec.env),
    ...sandboxRuntimeHelperAllowReadPaths(),
  ]
  const denyWrite = [
    ...readOnly.flatMap(tree),
    ...workspaceMandatoryWriteDenyPaths(spec.checkouts.base),
    ...workspaceMandatoryWriteDenyPaths(spec.checkouts.head),
  ]
  return {
    network: containedSandboxNetworkConfig(),
    filesystem: {
      denyRead: [homedir()],
      allowRead: [...new Set(allowRead)],
      allowWrite: writable.flatMap(tree),
      denyWrite: [...new Set(denyWrite)],
    },
  }
}

class OsSandboxCell implements ExecutionCell {
  readonly spec: CellSpec
  private readonly overlay: Partial<SandboxRuntimeConfig>
  private readonly env: NodeJS.ProcessEnv
  private readonly homeDir: string
  private readonly tmpDir: string
  private readonly live = new Set<ReturnType<typeof spawn>>()

  constructor(spec: CellSpec, homeDir: string, tmpDir: string) {
    this.spec = spec
    this.homeDir = homeDir
    this.tmpDir = tmpDir
    this.overlay = reviewCellSandboxOverlay(spec)
    this.env = withSandboxShellPath({
      ...spec.env,
      HOME: homeDir,
      TMPDIR: tmpDir,
      TMP: tmpDir,
      TEMP: tmpDir,
      TMPPREFIX: join(tmpDir, 'zsh'),
    })
  }

  async run(command: CellCommand): Promise<CellCommandResult> {
    const [executable, ...args] = command.argv
    const { argv } = await SandboxManager.wrapWithSandboxArgv(
      formatArgvForShell(executable, args),
      shellForSandboxWrap(),
      this.overlay,
    )
    const [file, ...rest] = argv
    if (file === undefined) throw new Error('sandbox wrap produced empty argv')
    const child = spawn(resolveSandboxShellExecutable(file), rest, {
      cwd: this.spec.checkouts[command.target],
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: detachForGroupKill,
    })
    this.live.add(child)
    try {
      return await collectProcess(child, command)
    } finally {
      this.live.delete(child)
    }
  }

  async destroy(): Promise<void> {
    for (const child of this.live) {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }
    this.live.clear()
    await rm(this.homeDir, { recursive: true, force: true })
    await rm(this.tmpDir, { recursive: true, force: true })
  }
}

/**
 * The backend, or `null` when ASRT is not active in this process — Windows,
 * a Linux host without usable user namespaces, or an init failure — in which
 * case the caller falls back to `decideExecution` with no isolation, which
 * for the author's own tree means asking, and for anything else means no.
 */
export function createOsSandboxBackend(): IsolationBackend | null {
  if (!isProjectSandboxEnabled()) return null
  return {
    id: OS_SANDBOX_BACKEND_ID,
    strength: 'os-sandbox',
    capabilities: {
      filesystemConfined: true,
      secretFreeEnvironment: true,
      networkDenied: true,
      ephemeral: true,
    },
    async createCell(spec: CellSpec): Promise<ExecutionCell> {
      const homeDir = join(spec.scratchDir, 'home')
      const tmpDir = join(spec.scratchDir, 'tmp')
      await mkdir(homeDir, { recursive: true })
      await mkdir(tmpDir, { recursive: true })
      return new OsSandboxCell(spec, homeDir, tmpDir)
    },
  }
}
