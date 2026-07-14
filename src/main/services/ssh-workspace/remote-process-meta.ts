import type { ChildProcess } from 'node:child_process'

export interface RemoteProcessMeta {
  hostId: string
  pgid: number
}

const remoteMeta = new WeakMap<ChildProcess, RemoteProcessMeta>()

export function registerRemoteProcessMeta(proc: ChildProcess, meta: RemoteProcessMeta): void {
  remoteMeta.set(proc, meta)
}

export function getRemoteProcessMeta(proc: ChildProcess): RemoteProcessMeta | undefined {
  return remoteMeta.get(proc)
}

export function clearRemoteProcessMeta(proc: ChildProcess): void {
  remoteMeta.delete(proc)
}

/** Test hook */
export function clearAllRemoteProcessMetaForTests(): void {
  // WeakMap cannot be cleared; tests use fresh ChildProcess objects.
}
