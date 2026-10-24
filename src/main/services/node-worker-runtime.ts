import { join } from 'node:path'
import { isElectronAppPackaged } from './electron-app-runtime.ts'

export interface NodeWorkerRuntime {
  packaged: boolean
  platform: NodeJS.Platform
  arch: string
  resourcesPath: string | undefined
  execPath: string
}
/** The trusted macOS app cannot also be a general-purpose Node interpreter. */
export function resolveNodeWorkerExecutable(runtime: NodeWorkerRuntime): string {
  if (!runtime.packaged || runtime.platform !== 'darwin') return runtime.execPath
  if (!runtime.resourcesPath || !['arm64', 'x64'].includes(runtime.arch)) {
    throw new Error('The packaged Node worker runtime is unavailable.')
  }
  return join(
    runtime.resourcesPath,
    'app.asar.unpacked',
    'dist',
    'resources',
    'node',
    runtime.arch,
    'node',
  )
}
export function nodeWorkerExecutable(): string {
  return resolveNodeWorkerExecutable({
    packaged: isElectronAppPackaged(),
    platform: process.platform,
    arch: process.arch,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
  })
}
/** Standalone Node cannot read Electron's virtual asar filesystem. */
export function nodeWorkerScript(path: string): string {
  return path.replace(/\.asar([/\\\\])/, '.asar.unpacked$1')
}
