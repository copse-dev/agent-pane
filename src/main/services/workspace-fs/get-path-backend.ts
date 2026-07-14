import type { ExecutionTarget } from '../ssh-workspace/execution-target.ts'
import { getActiveExecutionTarget } from '../ssh-workspace/execution-target.ts'
import type { PathBackend } from './path-backend.ts'
import { localPathBackend } from './local-path-backend.ts'

/**
 * Resolve the path backend for workspace containment checks. Phase 3a always
 * returns the local backend; Phase 3b will route SSH targets through remote fs.
 */
export function getPathBackend(_target: ExecutionTarget): PathBackend {
  void _target
  return localPathBackend
}

export function getActivePathBackend(): PathBackend {
  return getPathBackend(getActiveExecutionTarget())
}
