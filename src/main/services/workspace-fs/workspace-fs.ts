export interface WorkspaceBinaryReadOptions {
  /** Reject before reading or transferring a file larger than this many bytes. */
  maxBytes?: number
  signal?: AbortSignal
}

export interface MaterializedWorkspaceFile {
  /** Local path containing the bytes. The WorkspaceFs implementation owns its lifetime. */
  path: string
  sizeBytes: number
}

export class WorkspaceFileTooLargeError extends Error {
  readonly sizeBytes: number
  readonly maxBytes: number

  constructor(sizeBytes: number, maxBytes: number) {
    super(`Workspace file is ${String(sizeBytes)} bytes, over the ${String(maxBytes)} byte limit`)
    this.name = 'WorkspaceFileTooLargeError'
    this.sizeBytes = sizeBytes
    this.maxBytes = maxBytes
  }
}

export function enforceWorkspaceFileSize(sizeBytes: number, maxBytes?: number): void {
  if (maxBytes !== undefined && sizeBytes > maxBytes) {
    throw new WorkspaceFileTooLargeError(sizeBytes, maxBytes)
  }
}

/** Async workspace filesystem operations — local or remote (SSH). */
export interface WorkspaceFs {
  readFile: (path: string, encoding: 'utf-8') => Promise<string>
  readFileBytes: (path: string, options?: WorkspaceBinaryReadOptions) => Promise<Buffer>
  sizeOf: (path: string, options?: Pick<WorkspaceBinaryReadOptions, 'signal'>) => Promise<number>
  materializeToLocal: (
    path: string,
    options?: WorkspaceBinaryReadOptions,
  ) => Promise<MaterializedWorkspaceFile>
  writeFile: (path: string, content: string, encoding: 'utf-8') => Promise<void>
  writeFileBytes: (path: string, content: Buffer) => Promise<void>
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>
  rm: (path: string, options?: { force?: boolean; recursive?: boolean }) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  access: (path: string) => Promise<void>
  readdir: (path: string) => Promise<string[]>
  readdirWithTypes: (path: string) => Promise<Array<{ name: string; isDir: boolean }>>
}

export interface WorkspaceFsStat {
  isDirectory: () => boolean
  isFile: () => boolean
  isSymbolicLink: () => boolean
}

/** Extended stat/readlink surface for path containment (Phase 3a PathBackend alignment). */
export interface WorkspaceFsPathProbe extends WorkspaceFs {
  exists: (path: string) => Promise<boolean>
  stat: (path: string) => Promise<WorkspaceFsStat>
  lstat: (path: string) => Promise<WorkspaceFsStat>
  readlink: (path: string) => Promise<string>
  realpath: (path: string) => Promise<string>
}
