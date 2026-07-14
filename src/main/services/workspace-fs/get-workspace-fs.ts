import type { ExecutionTarget } from '../ssh-workspace/execution-target.ts'
import { getActiveExecutionTarget } from '../ssh-workspace/execution-target.ts'
import { localWorkspaceFs } from './local-workspace-fs.ts'
import type { WorkspaceFs, WorkspaceFsPathProbe } from './workspace-fs.ts'

/**
 * Resolve the workspace filesystem for I/O. Phase 3b returns local only;
 * a later commit adds `SshWorkspaceFs` for SSH targets.
 */
export function getWorkspaceFs(_target: ExecutionTarget): WorkspaceFsPathProbe {
  void _target
  return localWorkspaceFs
}

export function getActiveWorkspaceFs(): WorkspaceFsPathProbe {
  return getWorkspaceFs(getActiveExecutionTarget())
}

/** Narrow to the I/O surface when path probes are not needed. */
export function asWorkspaceFs(probe: WorkspaceFsPathProbe): WorkspaceFs {
  return probe
}
