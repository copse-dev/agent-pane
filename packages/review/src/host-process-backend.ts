// The weakest backend: the host process with a scrubbed environment.
//
// It builds no filesystem or network wall, and says so through its
// capabilities, so `decideExecution` lets it run only the author's own diff
// and only with explicit per-run consent. What it does guarantee — the
// conformance test holds it to this — is that the cell's processes inherit
// nothing from the orchestrator's environment, that `HOME` and `TMPDIR` point
// inside the cell, and that the cell's state is destroyed with it.
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CellCommand,
  CellCommandResult,
  CellSpec,
  ExecutionCell,
  IsolationBackend,
} from './isolation.ts'
import { collectProcess, killProcessTree } from './process-collect.ts'
import { removeTree } from './remove-tree.ts'

export const HOST_PROCESS_BACKEND_ID = 'host-process'

class HostProcessCell implements ExecutionCell {
  readonly spec: CellSpec
  private readonly env: Readonly<Record<string, string>>
  private readonly homeDir: string
  private readonly tmpDir: string
  private destroyed = false
  private readonly live = new Set<ReturnType<typeof spawn>>()

  constructor(spec: CellSpec, homeDir: string, tmpDir: string) {
    this.spec = spec
    this.homeDir = homeDir
    this.tmpDir = tmpDir
    this.env = { ...spec.env, HOME: homeDir, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir }
  }

  async run(command: CellCommand): Promise<CellCommandResult> {
    command.signal?.throwIfAborted()
    if (this.destroyed) throw new Error('Review cell has been destroyed')
    const [file, ...args] = command.argv
    const child = spawn(file, args, {
      cwd: this.spec.checkouts[command.target],
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a timeout kills the tree the command forked.
      detached: process.platform !== 'win32',
    })
    this.live.add(child)
    try {
      return await collectProcess(child, command)
    } finally {
      this.live.delete(child)
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    const closed = [...this.live].map(
      (child) =>
        new Promise<void>((resolve) =>
          child.once('close', () => {
            resolve()
          }),
        ),
    )
    for (const child of this.live) killProcessTree(child, 'SIGKILL')
    await Promise.all(closed)
    this.live.clear()
    await removeTree(this.homeDir)
    await removeTree(this.tmpDir)
  }
}

async function createHostProcessCell(spec: CellSpec): Promise<ExecutionCell> {
  const homeDir = join(spec.scratchDir, 'home')
  const tmpDir = join(spec.scratchDir, 'tmp')
  await mkdir(homeDir, { recursive: true })
  await mkdir(tmpDir, { recursive: true })
  return new HostProcessCell(spec, homeDir, tmpDir)
}

export function createHostProcessBackend(): IsolationBackend {
  return {
    id: HOST_PROCESS_BACKEND_ID,
    strength: 'none',
    capabilities: {
      filesystemConfined: false,
      secretFreeEnvironment: true,
      networkDenied: false,
      ephemeral: true,
    },
    createCell: createHostProcessCell,
  }
}

export const EPHEMERAL_RUNNER_BACKEND_ID = 'ephemeral-runner'

/**
 * The host process again, on a machine that IS the cell: a CI runner created
 * for one job and discarded after it, holding no secrets (§Execution
 * isolation, "Backend per shell — CI", job A). The wall is the runner's, not
 * this process's — the same strength as a container, which is what lets a
 * foreign diff execute here (B3) — so declaring it is the caller's assertion
 * about where it runs, never a detection. The CLI takes it only from an
 * explicit `--backend ephemeral-runner`; the workflows that pass it are the
 * ones built to the plan's job-A shape: a trusted default-branch workflow, no
 * secrets, `permissions: {}`, a fresh hosted runner. Inside the process it guarantees
 * what the host-process backend guarantees (a scrubbed environment, `HOME`
 * and `TMPDIR` inside the cell) and declares nothing more, so the conformance
 * test holds it to exactly that.
 */
export function createEphemeralRunnerBackend(): IsolationBackend {
  return {
    id: EPHEMERAL_RUNNER_BACKEND_ID,
    strength: 'container',
    capabilities: {
      filesystemConfined: false,
      secretFreeEnvironment: true,
      networkDenied: false,
      ephemeral: true,
    },
    createCell: createHostProcessCell,
  }
}
