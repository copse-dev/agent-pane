import type { ExecutionTarget } from '../ssh-workspace/execution-target.ts'
import { getActiveExecutionTarget } from '../ssh-workspace/execution-target.ts'
import { getWorkspaceFs } from './get-workspace-fs.ts'
import type { PathBackend } from './path-backend.ts'

/** Path probes share the active {@link getWorkspaceFs} backend. */
export function getPathBackend(target: ExecutionTarget): PathBackend {
  return getWorkspaceFs(target)
}

export function getActivePathBackend(): PathBackend {
  return getPathBackend(getActiveExecutionTarget())
}
