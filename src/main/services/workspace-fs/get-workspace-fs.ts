import type { ExecutionTarget } from '../ssh-workspace/execution-target.ts'
import {
  getActiveExecutionTarget,
  isSshExecutionTarget,
} from '../ssh-workspace/execution-target.ts'
import { localWorkspaceFs } from './local-workspace-fs.ts'
import { getSshWorkspaceFs } from './ssh-workspace-fs.ts'
import type { WorkspaceFsPathProbe } from './workspace-fs.ts'

/** Resolve the workspace filesystem for I/O (local disk or SSH exec-based). */
export function getWorkspaceFs(target: ExecutionTarget): WorkspaceFsPathProbe {
  if (isSshExecutionTarget(target)) {
    return getSshWorkspaceFs(target.hostId, target.remoteRoot)
  }
  return localWorkspaceFs
}

export function getActiveWorkspaceFs(): WorkspaceFsPathProbe {
  return getWorkspaceFs(getActiveExecutionTarget())
}
