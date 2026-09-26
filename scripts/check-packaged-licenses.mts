/**
 * Check a packaged app's licence obligations against what is really inside it.
 *
 * The build writes the licence report from what it *expects* electron-builder
 * to copy (see scripts/lib/third-party-licenses.mts). This reads the archive
 * electron-builder actually produced and fails when:
 *
 * - a package in app.asar's node_modules is missing from the shipped report
 *   (electron-builder's dependency walk and ours disagreed);
 * - a package there is GPL-family only, or is sharp / libvips. sharp is kept
 *   out only because electron-builder does not follow Rampart's optional peer
 *   dependency on @huggingface/transformers (THIRD_PARTY_NOTICES.md, "Not
 *   shipped: sharp and libvips"); nothing else would notice if that changed;
 * - the licence files themselves are missing.
 *
 * Runs from scripts/after-pack.cjs on every package, and by hand against any
 * app: `node scripts/check-packaged-licenses.mts /Applications/Copse.app`.
 */
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import {
  CHROMIUM_LICENSES_FILE,
  COPSE_LICENSE_FILE,
  THIRD_PARTY_LICENSE_JSON,
  THIRD_PARTY_LICENSE_TEXT,
  THIRD_PARTY_LICENSES_DIR,
} from '../src/shared/third-party-licenses.mts'
import { openAsar, type AsarArchive } from './lib/asar-archive.mts'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'
import { declaredLicense, isGplFamilyOnly } from './lib/third-party-licenses.mts'

/** Packages that must never be in the app, whatever their manifest says. */
const FORBIDDEN_PACKAGE_RE = /^(?:sharp|@img\/sharp-.*)$/

export interface PackagedPackage {
  name: string
  version: string
  license: string
  path: string
}

/** Package roots: `…/node_modules/<name>/package.json` or `…/node_modules/@scope/<name>/package.json`. */
export function packageManifestPaths(files: readonly string[]): string[] {
  return files.filter((path) => {
    const parts = path.split('/')
    if (parts.at(-1) !== 'package.json') return false
    const at = parts.lastIndexOf('node_modules')
    if (at < 0) return false
    const rest = parts.slice(at + 1, -1)
    return rest.length === 1 || (rest.length === 2 && rest[0]?.startsWith('@') === true)
  })
}

const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  license: z.union([z.string(), z.object({ type: z.string().optional() })]).optional(),
  licenses: z.array(z.union([z.string(), z.object({ type: z.string().optional() })])).optional(),
})

export function packagedPackages(archive: AsarArchive): PackagedPackage[] {
  return packageManifestPaths(archive.files).flatMap((path) => {
    const manifest = safeJsonParse(
      archive.readFile(path).toString('utf8'),
      decodeWithSchema(manifestSchema),
    )
    // A package.json without a name/version is a nested `{"type":"module"}`
    // marker, not a package.
    if (!manifest) return []
    return [
      { name: manifest.name, version: manifest.version, license: declaredLicense(manifest), path },
    ]
  })
}

const reportSchema = z.object({
  components: z.array(z.object({ name: z.string(), version: z.string() })),
})

export function findPackagedLicenseProblems(archive: AsarArchive): string[] {
  const problems: string[] = []
  const reportPath = `${THIRD_PARTY_LICENSES_DIR}/${THIRD_PARTY_LICENSE_JSON}`
  for (const name of [
    THIRD_PARTY_LICENSE_JSON,
    THIRD_PARTY_LICENSE_TEXT,
    CHROMIUM_LICENSES_FILE,
    COPSE_LICENSE_FILE,
  ]) {
    if (!archive.files.includes(`${THIRD_PARTY_LICENSES_DIR}/${name}`)) {
      problems.push(`${THIRD_PARTY_LICENSES_DIR}/${name} is not in the app`)
    }
  }
  const report = archive.files.includes(reportPath)
    ? safeJsonParse(archive.readFile(reportPath).toString('utf8'), decodeWithSchema(reportSchema))
    : null
  const listed = new Set((report?.components ?? []).map((c) => `${c.name}@${c.version}`))

  for (const pkg of packagedPackages(archive)) {
    const id = `${pkg.name}@${pkg.version}`
    if (FORBIDDEN_PACKAGE_RE.test(pkg.name)) {
      problems.push(`${id} (${pkg.path}) must not ship: sharp and libvips are LGPL`)
    } else if (isGplFamilyOnly(pkg.license)) {
      problems.push(`${id} (${pkg.path}) is ${pkg.license}`)
    }
    if (report && !listed.has(id)) {
      problems.push(`${id} (${pkg.path}) ships without an entry in ${THIRD_PARTY_LICENSE_JSON}`)
    }
  }
  return problems
}

/** The `Resources` directory holding app.asar, for a `.app` bundle or an unpacked build dir. */
export function resourcesDir(appPath: string): string {
  return appPath.endsWith('.app')
    ? join(appPath, 'Contents', 'Resources')
    : join(appPath, 'resources')
}

export function assertPackagedLicenses(resources: string): void {
  const asarPath = join(resources, 'app.asar')
  if (!existsSync(asarPath)) throw new Error(`[licenses] no app.asar in ${resources}`)
  const problems = findPackagedLicenseProblems(openAsar(asarPath))
  if (problems.length > 0) {
    throw new Error(
      `[licenses] the packaged app fails its licence checks:\n  ${problems.join('\n  ')}`,
    )
  }
}

if (basename(process.argv[1] ?? '') === 'check-packaged-licenses.mts') {
  const app = process.argv[2]
  if (!app) {
    console.error('Usage: node scripts/check-packaged-licenses.mts <path/to/Copse.app>')
    process.exit(2)
  }
  assertPackagedLicenses(resourcesDir(app))
  console.log(`[licenses] ${app}: licence checks pass`)
}
