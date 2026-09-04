import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Pin source-relative Node metadata before esbuild moves modules into shared chunks.
 *
 * Paths must be function replacements: JavaScript expands `$` replacement tokens
 * in replacement strings, and `$` is valid in every path segment.
 */
export function rewriteModuleRelativeTestPaths(
  source: string,
  sourcePath: string,
  outputPath: string,
): string {
  return source
    .replace(/\bimport\.meta\.url\b/g, () => JSON.stringify(pathToFileURL(sourcePath).href))
    .replace(/\bimport\.meta\.dirname\b/g, () => JSON.stringify(dirname(sourcePath)))
    .replace(/\b__filename\b/g, () => JSON.stringify(outputPath))
    .replace(/\b__dirname\b/g, () => JSON.stringify(dirname(outputPath)))
}
