import { realpathSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Match the actual entrypoint, including symlinked CLI paths and macOS /var aliases. */
export function isDirectExecution(
  moduleUrl: string | undefined,
  commandName: string,
  commonJsFilename?: string,
  entrypoint = process.argv[1],
): boolean {
  if (!entrypoint) return false
  try {
    // esbuild's CommonJS bundles have no import.meta.url; their __filename is
    // the bundle identity. A basename alone cannot distinguish an importer.
    const filename = moduleUrl ? fileURLToPath(moduleUrl) : commonJsFilename
    if (!filename) return false
    const canonicalModule = realpathSync(filename)
    // Imported source modules share import.meta.url with their enclosing test
    // bundle. Only the named CLI bundle may serve as this command's entrypoint.
    return (
      basename(canonicalModule, extname(canonicalModule)) === commandName &&
      realpathSync(entrypoint) === canonicalModule
    )
  } catch {
    return false
  }
}
