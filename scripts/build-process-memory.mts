import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

/** Build-time only: shipped apps never need Xcode or a runtime compiler. */
export function buildProcessMemoryHelper(): void {
  if (process.platform !== 'darwin') return
  mkdirSync('dist/resources', { recursive: true })
  // Both slices support local cross-packaging. afterPack thins before signing.
  const helper = spawnSync(
    'xcrun',
    [
      'clang',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-arch',
      'arm64',
      '-arch',
      'x86_64',
      'src/main/services/process-manager-memory.c',
      '-lproc',
      '-o',
      'dist/resources/process-memory',
    ],
    { stdio: 'inherit' },
  )
  if (helper.error) throw helper.error
  if (helper.status !== 0) throw new Error('Failed to build macOS process memory helper')
}
