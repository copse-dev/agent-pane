import { existsSync, readdirSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { copseWorkspaceDir } from '@copse/store-kit/copse-paths.ts'

/**
 * Facts the store cannot know on its own and the host supplies once.
 *
 * - `workspaceRoot`: where the per-project thread directories live. The default
 *   honours `COPSE_WORKSPACE_DIR` and otherwise uses `~/.copse/workspace`; the
 *   Copse app binds it to the same resolver its sandbox overlay uses, so the two
 *   never disagree about where the store is.
 * - `listProjectIds`: the projects whose stores the "all projects" readers walk.
 *   The default enumerates the directories under the root; the app binds it to
 *   its configured project list so an orphaned directory is not mistaken for a
 *   project.
 * - `perf`: optional tracing hooks. The default is a no-op; the app binds its
 *   perf-trace counters and spans.
 *
 * Functions rather than values because the root can change at runtime (tests
 * repoint `COPSE_WORKSPACE_DIR` per case) and the store reads it per call.
 */
export type PerfDetail = Record<string, string | number | boolean | undefined>

export interface ThreadStorePerf {
  count(name: string, ms?: number, bytes?: number): void
  span<T>(
    name: string,
    fn: () => Promise<T>,
    detail?: PerfDetail | ((value: T | undefined) => PerfDetail),
  ): Promise<T>
}

export interface ThreadStoreEnvironment {
  workspaceRoot: () => string
  listProjectIds: () => string[]
  perf: ThreadStorePerf
}

export function defaultWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return copseWorkspaceDir(env)
}

/** Directory names directly under `root`, or none when the root does not exist. */
export function listProjectDirs(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/**
 * Per-project directory under the store (`<root>/<projectId>`). The durable
 * decision log writes per-project files, so a project id that escapes the root is
 * rejected rather than resolved.
 */
export function resolveProjectDir(root: string, projectId: string): string {
  const resolvedRoot = resolve(root)
  const candidate = resolve(resolvedRoot, projectId)
  const rel = relative(resolvedRoot, candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Project id resolves outside the workspace store')
  }
  return candidate
}

const NO_PERF: ThreadStorePerf = {
  count: () => {},
  span: (_name, fn) => fn(),
}

const DEFAULTS: ThreadStoreEnvironment = {
  workspaceRoot: () => defaultWorkspaceRoot(),
  listProjectIds: () => listProjectDirs(environment.workspaceRoot()),
  perf: NO_PERF,
}

let environment: ThreadStoreEnvironment = DEFAULTS

/** Install the host environment. Passing nothing restores the defaults. */
export function configureThreadStore(next: Partial<ThreadStoreEnvironment> = {}): void {
  environment = { ...DEFAULTS, ...next }
}

export function threadStoreEnvironment(): ThreadStoreEnvironment {
  return environment
}
