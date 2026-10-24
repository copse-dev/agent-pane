import { createRequire } from 'node:module'

/** Electron exports its executable path to Node; its declarations describe the in-app API. */
export function resolveElectronExecutable(
  load: () => unknown = () => createRequire(import.meta.url)('electron'),
): string {
  const executable = load()
  if (typeof executable !== 'string' || executable.trim() === '') {
    throw new Error('Electron did not export an executable path')
  }
  return executable
}
