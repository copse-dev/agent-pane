/**
 * Code mode (experimental, off by default): the agent's `run_code` tool runs a
 * TypeScript cell in a container kept for its thread, and the cell calls
 * read-only Copse tools through the host. Turning the setting on is the
 * consent: cells never prompt. The tools a cell calls still pass their own
 * gates (`code-cell-tools.ts`).
 *
 * This module owns the process's one {@link CodeCellPool} and the entry points
 * the rest of the app calls: the setting's sync, a thread's archive or delete,
 * and quit.
 */
import { getSetting } from '../storage/settings.ts'
import {
  reachableThreadContainerEngines,
  resolveThreadContainerEngine,
  type ThreadContainerEngine,
} from '../container-runtime/container-engine.ts'
import { listManagedRuntimes, teardownRuntime } from '../container-runtime/thread-container.ts'
import {
  CODE_CELL_RUNTIME_PREFIX,
  CodeCellContainer,
  DEFAULT_CODE_CELL_LIMITS,
  newCodeCellRuntimeId,
} from './code-cell-container.ts'
import { ensureCodeCellImage } from './code-cell-image.ts'
import { CodeCellPool, type CodeCellOwner } from './code-cell-pool.ts'

export const CODE_MODE_ENABLED_SETTING = 'codeModeEnabled'

export function codeModeEnabled(): boolean {
  return getSetting<boolean>(CODE_MODE_ENABLED_SETTING, false)
}

let engine: Promise<ThreadContainerEngine> | null = null

/** The engine for this app session's code cells, probed once; a failed probe is retried. */
function codeCellEngine(): Promise<ThreadContainerEngine> {
  const current = engine ?? resolveThreadContainerEngine()
  engine = current
  current.catch(() => {
    if (engine === current) engine = null
  })
  return current
}

async function startCodeCellContainer(): Promise<CodeCellContainer> {
  const resolved = await codeCellEngine()
  const image = await ensureCodeCellImage(resolved)
  return await CodeCellContainer.start({
    engine: resolved,
    image,
    runtimeId: newCodeCellRuntimeId(),
    ...DEFAULT_CODE_CELL_LIMITS,
  })
}

/**
 * Remove code-cell containers an earlier app session left stopped. Docker
 * removes its own (`--rm`); Apple container keeps a stopped one until it is
 * deleted. A running one is left alone: it may belong to another instance of
 * the app, and one this host lost exits once its link closes.
 */
async function sweepCodeCellContainers(): Promise<void> {
  for (const each of await reachableThreadContainerEngines()) {
    for (const runtime of await listManagedRuntimes(each)) {
      if (runtime.running || !runtime.runtimeId.startsWith(CODE_CELL_RUNTIME_PREFIX)) continue
      await teardownRuntime(runtime.runtimeId, each)
    }
  }
}

let pool: CodeCellPool | null = null

export function getCodeCellPool(): CodeCellPool {
  pool ??= new CodeCellPool({ start: startCodeCellContainer, sweep: sweepCodeCellContainers })
  return pool
}

/**
 * Match the pool to the setting: on keeps a spare container warm, off removes
 * every code-cell container. Called at start-up and when the setting changes.
 */
export async function syncCodeCellPool(): Promise<void> {
  if (codeModeEnabled()) {
    getCodeCellPool().enable()
    return
  }
  await pool?.disable()
}

/** Remove a thread's container, when it has one: on archive and delete. */
export async function discardCodeCellContainer(owner: CodeCellOwner): Promise<void> {
  await pool?.discard(owner)
}

/** Remove every code-cell container: on quit. */
export async function stopAllCodeCellContainers(): Promise<void> {
  await pool?.stopAll()
}
