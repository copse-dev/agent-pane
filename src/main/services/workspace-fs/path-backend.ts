/** Async filesystem probes used by workspace path resolution. */
export interface PathBackend {
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<{ isDirectory(): boolean }>
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>
  readlink(path: string): Promise<string>
  realpath(path: string): Promise<string>
}
