import { existsSync, readdirSync, symlinkSync } from 'node:fs'
import { basename, join } from 'node:path'

const VERSION = 'A'

function ensureSymlink(path: string, target: string): void {
  if (!existsSync(path)) symlinkSync(target, path)
}

/**
 * npm omits the conventional symlinks from xcodebuildmcp's versioned macOS
 * frameworks. Without them codesign cannot recognize the framework bundle.
 * Restore only links whose targets are present in the packaged dependency.
 */
export function repairVersionedMacosFrameworks(frameworksDirectory: string): void {
  for (const entry of readdirSync(frameworksDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.framework')) continue

    const framework = join(frameworksDirectory, entry.name)
    const executable = basename(entry.name, '.framework')
    const versionDirectory = join(framework, 'Versions', VERSION)
    const links = [
      [join(framework, 'Versions', 'Current'), VERSION],
      [join(framework, executable), `Versions/Current/${executable}`],
      [join(framework, 'Headers'), 'Versions/Current/Headers'],
      [join(framework, 'Modules'), 'Versions/Current/Modules'],
      [join(framework, 'Resources'), 'Versions/Current/Resources'],
    ] as const

    for (const target of [executable, 'Headers', 'Modules', 'Resources']) {
      if (!existsSync(join(versionDirectory, target))) {
        throw new Error(`Cannot repair ${entry.name}: missing Versions/${VERSION}/${target}`)
      }
    }
    for (const [path, target] of links) ensureSymlink(path, target)
  }
}
