import type { PathBackend } from './path-backend.ts'
import { localWorkspaceFs } from './local-workspace-fs.ts'

/** Local disk backend — delegates to {@link localWorkspaceFs}. */
export const localPathBackend: PathBackend = {
  exists: (path) => localWorkspaceFs.exists(path),
  stat: (path) => localWorkspaceFs.stat(path),
  lstat: (path) => localWorkspaceFs.lstat(path),
  readlink: (path) => localWorkspaceFs.readlink(path),
  realpath: (path) => localWorkspaceFs.realpath(path),
}
