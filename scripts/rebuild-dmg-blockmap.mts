import { createRequire } from 'node:module'

/**
 * Rebuild a DMG's `.blockmap` from the DMG as it is now.
 *
 * electron-builder writes the blockmap while it builds and signs the DMG. The
 * release workflow then notarizes the DMG and staples the ticket to it, which
 * rewrites the image, so the blockmap has to be rebuilt from the final bytes.
 * This uses electron-builder's own block-map builder (gzip, beside the file),
 * so the result matches what electron-builder would have written. The feeds and
 * SHA256SUMS need nothing here: `assemble-macos-release.mts` rehashes every
 * package from disk.
 */

export type BuildBlockMap = (
  inFile: string,
  compressionFormat: 'gzip',
  outFile: string,
) => Promise<unknown>

/** electron-builder's block-map builder, reached through its own dependency tree. */
export function loadBuildBlockMap(): BuildBlockMap {
  const fromRoot = createRequire(import.meta.url)
  const fromBuilder = createRequire(fromRoot.resolve('electron-builder/package.json'))
  const fromLib = createRequire(fromBuilder.resolve('app-builder-lib/package.json'))
  const loaded: unknown = fromLib('app-builder-lib/out/targets/blockmap/blockmap.js')
  if (
    typeof loaded !== 'object' ||
    loaded === null ||
    !('buildBlockMap' in loaded) ||
    typeof loaded.buildBlockMap !== 'function'
  ) {
    throw new Error('app-builder-lib no longer exports buildBlockMap from out/targets/blockmap')
  }
  const build = loaded.buildBlockMap
  return async (inFile, compressionFormat, outFile) => {
    const result: unknown = await Reflect.apply(build, undefined, [
      inFile,
      compressionFormat,
      outFile,
    ])
    return result
  }
}

export async function rebuildDmgBlockmap(
  dmg: string,
  build: BuildBlockMap = loadBuildBlockMap(),
): Promise<string> {
  if (!dmg.endsWith('.dmg')) throw new Error(`Not a DMG: ${dmg}`)
  const blockmap = `${dmg}.blockmap`
  await build(dmg, 'gzip', blockmap)
  return blockmap
}

const USAGE = 'Usage: node scripts/rebuild-dmg-blockmap.mts <file.dmg> [...]'

async function main(): Promise<void> {
  const dmgs = process.argv.slice(2)
  if (dmgs.length === 0) throw new Error(USAGE)
  const build = loadBuildBlockMap()
  for (const dmg of dmgs) {
    console.log(`Rebuilt ${await rebuildDmgBlockmap(dmg, build)}`)
  }
}

// Importing this module for its helpers must not run it.
if (process.argv[1]?.endsWith('rebuild-dmg-blockmap.mts') === true) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
