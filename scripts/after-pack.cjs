/**
 * Keep each macOS package architecture-pure before signing. Local builds may
 * still cross-pack both architectures from a universal gortex, while release
 * CI supplies one target-specific gortex to each matrix job.
 */
module.exports = async function afterPack(context) {
  await checkLicenses(context)
  if (context.electronPlatformName === 'linux') {
    const { Arch } = await import('electron-builder')
    const arch = context.arch === Arch.arm64 ? 'arm64' : context.arch === Arch.x64 ? 'x64' : null
    if (!arch) throw new Error(`Unsupported Linux package architecture ${String(context.arch)}`)
    checkLinuxNatives(require('node:path').join(context.appOutDir, 'resources'), arch)
    return
  }
  if (context.electronPlatformName !== 'darwin') return

  // `Arch` originates in builder-util, but that is only a transitive dependency:
  // pnpm's isolated linker gives top-level symlinks to direct dependencies alone,
  // so a bare import of it from this script fails to resolve on a clean install.
  // electron-builder is a direct dependency and re-exports the very same enum.
  const [
    { execFileSync },
    { renameSync, rmSync },
    { join },
    { Arch },
    { repairVersionedMacosFrameworks },
    { pruneForeignMacosPayloads },
  ] = await Promise.all([
    import('node:child_process'),
    import('node:fs'),
    import('node:path'),
    import('electron-builder'),
    import('./lib/repair-macos-frameworks.mts'),
    import('./lib/prune-macos-foreign-payloads.mts'),
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
  repairVersionedMacosFrameworks(
    join(resources, 'node_modules', 'xcodebuildmcp', 'bundled', 'Frameworks'),
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
  pruneForeignMacosPayloads(join(resources, 'node_modules'), keyringPackageArch)

  const memoryHelper = join(resources, 'dist', 'resources', 'process-memory')
  const memoryHelperThin = `${memoryHelper}.thin`
  try {
    execFileSync('lipo', [memoryHelper, '-thin', targetArch, '-output', memoryHelperThin])
    renameSync(memoryHelperThin, memoryHelper)
  } finally {
    rmSync(memoryHelperThin, { force: true })
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

/**
 * Read the packaged app.asar and fail when a package in it has no entry in the
 * shipped licence report, is GPL-family only, or is sharp/libvips — or when the
 * report/runtime notice files are missing. See scripts/check-packaged-licenses.mts.
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

/** ELF `e_machine` values for the Linux architectures we package. */
const ELF_MACHINE = { x64: 0x3e, arm64: 0xb7 }

/**
 * Linux packages skip electron-builder's native rebuild (`-c.npmRebuild=false`):
 * every native addon is Node-API, and @electron/rebuild deletes node-pty's
 * `build/` before fetching Electron headers, so a failed fetch leaves an app
 * whose main process cannot load `pty.node` at startup. Fail the package
 * instead when a native binary is missing or built for the wrong architecture.
 */
function checkLinuxNatives(resources, arch) {
  const { accessSync, closeSync, constants, openSync, readSync } = require('node:fs')
  const { join } = require('node:path')
  const unpacked = join(resources, 'app.asar.unpacked')
  const binaries = [
    join(unpacked, 'dist', 'resources', 'gortex', 'gortex'),
    join(unpacked, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'),
    join(
      unpacked,
      'node_modules',
      '@napi-rs',
      `keyring-linux-${arch}-gnu`,
      `keyring.linux-${arch}-gnu.node`,
    ),
  ]
  // ASRT execs these by path inside bubblewrap, so they must also be executable.
  const executables = [
    join(unpacked, 'dist', 'resources', 'gortex', 'gortex'),
    join(
      unpacked,
      'node_modules',
      '@anthropic-ai',
      'sandbox-runtime',
      'vendor',
      'seccomp',
      arch,
      'apply-seccomp',
    ),
  ]
  binaries.push(executables[1])
  for (const binary of binaries) {
    const header = Buffer.alloc(20)
    let fd
    try {
      fd = openSync(binary, 'r')
      readSync(fd, header, 0, header.length, 0)
    } catch (error) {
      throw new Error(`Packaged ${arch} Linux app lacks ${binary}`, { cause: error })
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    if (header.readUInt32BE(0) !== 0x7f454c46) {
      throw new Error(`Packaged native binary is not an ELF file: ${binary}`)
    }
    const machine = header.readUInt16LE(18)
    if (machine !== ELF_MACHINE[arch]) {
      throw new Error(
        `Packaged native binary ${binary} targets ELF machine 0x${machine.toString(16)}, not ${arch}`,
      )
    }
  }
  for (const executable of executables) {
    try {
      accessSync(executable, constants.X_OK)
    } catch (error) {
      throw new Error(`Packaged ${arch} Linux helper is not executable: ${executable}`, {
        cause: error,
      })
    }
  }
}

module.exports.checkLinuxNatives = checkLinuxNatives
