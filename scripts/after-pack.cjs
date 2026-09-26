/**
 * Keep each macOS package architecture-pure before signing. Local builds may
 * still cross-pack both architectures from a universal gortex, while release
 * CI supplies one target-specific gortex to each matrix job.
 */
module.exports = async function afterPack(context) {
  await checkLicenses(context)
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

  const resources = join(
    context.appOutDir,
    'Copse.app',
    'Contents',
    'Resources',
    'app.asar.unpacked',
  )
  const binary = join(resources, 'dist', 'resources', 'gortex', 'gortex')
  const archs = execFileSync('lipo', [binary, '-archs'], { encoding: 'utf8' }).trim().split(/\s+/)
  if (!archs.includes(targetArch)) {
    throw new Error(`Bundled gortex lacks required ${targetArch} slice (${archs.join(', ')})`)
  }

  const keyringPackageArch = targetArch === 'x86_64' ? 'x64' : targetArch
  const keyring = join(
    resources,
    'node_modules',
    '@napi-rs',
    `keyring-darwin-${keyringPackageArch}`,
    `keyring.darwin-${keyringPackageArch}.node`,
  )
  let keyringArchs
  try {
    keyringArchs = execFileSync('lipo', [keyring, '-archs'], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
  } catch (error) {
    throw new Error(`Packaged ${keyringPackageArch} app lacks its native keyring binary`, {
      cause: error,
    })
  }
  if (!keyringArchs.includes(targetArch)) {
    throw new Error(
      `Bundled keyring lacks required ${targetArch} slice (${keyringArchs.join(', ')})`,
    )
  }

  // pnpm installs both optional keyring packages on macOS so either architecture
  // can be cross-packed. Only one can load in this app, so do not make every
  // customer carry the other native binary.
  const unusedKeyringPackageArch = keyringPackageArch === 'x64' ? 'arm64' : 'x64'
  rmSync(
    join(resources, 'node_modules', '@napi-rs', `keyring-darwin-${unusedKeyringPackageArch}`),
    { recursive: true, force: true },
  )

  if (archs.length === 1) return

  const thinned = `${binary}.thin`
  try {
    execFileSync('lipo', [binary, '-thin', targetArch, '-output', thinned])
    renameSync(thinned, binary)
  } finally {
    rmSync(thinned, { force: true })
  }
}

/**
 * Read the packaged app.asar and fail when a package in it has no entry in the
 * shipped licence report, is GPL-family only, or is sharp/libvips — or when the
 * licence files themselves are missing. See scripts/check-packaged-licenses.mts.
 * Runs before the macOS steps below so it covers every platform; the keyring
 * binary they delete is in the report either way.
 */
async function checkLicenses(context) {
  const [{ join }, { pathToFileURL }] = await Promise.all([import('node:path'), import('node:url')])
  const { assertPackagedLicenses } = await import(
    pathToFileURL(join(__dirname, 'check-packaged-licenses.mts')).href
  )
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources',
        )
      : join(context.appOutDir, 'resources')
  assertPackagedLicenses(resources)
}
