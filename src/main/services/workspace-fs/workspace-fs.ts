/** Async workspace filesystem operations — local or remote (SSH). */
export interface WorkspaceFs {
  readFile(path: string, encoding: 'utf-8'): Promise<string>
  readFileBytes(path: string): Promise<Buffer>
  writeFile(path: string, content: string, encoding: 'utf-8'): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>
  access(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  readdirWithTypes(path: string): Promise<Array<{ name: string; isDir: boolean }>>
}

export interface WorkspaceFsStat {
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

/** Extended stat/readlink surface for path containment (Phase 3a PathBackend alignment). */
export interface WorkspaceFsPathProbe extends WorkspaceFs {
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<WorkspaceFsStat>
  lstat(path: string): Promise<WorkspaceFsStat>
  readlink(path: string): Promise<string>
  realpath(path: string): Promise<string>
}
