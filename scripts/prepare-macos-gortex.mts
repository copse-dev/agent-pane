import { execFileSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin') {
  throw new Error('prepare-macos-gortex must run on macOS')
}

const bundled = resolve('vendor/gortex/gortex')
const existingArchs = execFileSync('lipo', [bundled, '-archs'], { encoding: 'utf8' })
  .trim()
  .split(/\s+/)

if (existingArchs.includes('arm64') && existingArchs.includes('x86_64')) {
  console.log('[prepare-macos-gortex] universal gortex already present')
  process.exit(0)
}

const targetArch = process.arch === 'arm64' ? 'x64' : 'arm64'
const tempRoot = mkdtempSync(join(tmpdir(), 'copse-gortex-universal-'))
const crossDir = join(tempRoot, targetArch)
const universal = join(tempRoot, 'gortex')

try {
  execFileSync(process.execPath, ['scripts/fetch-gortex.mts'], {
    env: {
      ...process.env,
      GORTEX_OUT_DIR: crossDir,
      GORTEX_TARGET_ARCH: targetArch,
    },
    stdio: 'inherit',
  })
  execFileSync('lipo', ['-create', bundled, join(crossDir, 'gortex'), '-output', universal])
  execFileSync('lipo', [universal, '-verify_arch', 'arm64', 'x86_64'])
  renameSync(universal, bundled)
  console.log('[prepare-macos-gortex] installed universal arm64/x86_64 binary')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
