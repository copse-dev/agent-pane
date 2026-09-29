import type { ChildProcess } from 'node:child_process'

export interface RemoteProcessMeta {
  hostId: string
  pgid: number
}

const remoteMeta = new WeakMap<ChildProcess, RemoteProcessMeta>()

export function registerRemoteProcessMeta(proc: ChildProcess, meta: RemoteProcessMeta): void {
  remoteMeta.set(proc, meta)
}

/** Read and clear the remote process identity before beginning its one teardown. */
export function takeRemoteProcessMeta(proc: ChildProcess): RemoteProcessMeta | undefined {
  const meta = remoteMeta.get(proc)
  remoteMeta.delete(proc)
  return meta
}
