/**
 * electron-builder cross-packs both macOS architectures from one dist tree.
 * The release build therefore starts with a universal gortex, then this hook
 * thins each app before signing so Intel and Apple Silicon packages contain the
 * correct executable without paying the size cost of both slices.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  // `Arch` originates in builder-util, but that is only a transitive dependency:
  // pnpm's isolated linker gives top-level symlinks to direct dependencies alone,
  // so a bare import of it from this script fails to resolve on a clean install.
  // electron-builder is a direct dependency and re-exports the very same enum.
  const [{ execFileSync }, { renameSync, rmSync }, { join }, { Arch }] = await Promise.all([
    import('node:child_process'),
    import('node:fs'),
    import('node:path'),
    import('electron-builder'),
  ])

  const targetArch =
    context.arch === Arch.arm64 ? 'arm64' : context.arch === Arch.x64 ? 'x86_64' : null
  if (!targetArch) return

  const binary = join(
    context.appOutDir,
    'Copse.app',
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'dist',
    'resources',
    'gortex',
    'gortex',
  )
  const archs = execFileSync('lipo', [binary, '-archs'], { encoding: 'utf8' }).trim().split(/\s+/)
  if (!archs.includes(targetArch)) {
    throw new Error(`Bundled gortex lacks required ${targetArch} slice (${archs.join(', ')})`)
  }
  if (archs.length === 1) return

  const thinned = `${binary}.thin`
  try {
    execFileSync('lipo', [binary, '-thin', targetArch, '-output', thinned])
    renameSync(thinned, binary)
  } finally {
    rmSync(thinned, { force: true })
  }
}
