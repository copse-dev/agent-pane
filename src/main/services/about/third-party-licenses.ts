import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import {
  CHROMIUM_LICENSES_FILE,
  COPSE_LICENSE_FILE,
  THIRD_PARTY_LICENSE_JSON,
  THIRD_PARTY_LICENSE_REPORT_VERSION,
  THIRD_PARTY_LICENSE_TEXT,
  THIRD_PARTY_SHIPPED_AS,
  type LicenseFileKind,
  type ThirdPartyLicenseReport,
} from '@shared/third-party-licenses.mts'

/**
 * The licence files the build writes beside `dist/main` (see
 * scripts/write-third-party-licenses.mts). In a packaged app they are unpacked
 * from app.asar, so the path handed to another application has to name the
 * `app.asar.unpacked` copy: nothing outside Electron can read inside the asar.
 */
export function licensesDir(mainDir: string = __dirname): string {
  return join(mainDir, '..', 'resources', 'licenses').replace(
    /([\\/])app\.asar([\\/])/,
    '$1app.asar.unpacked$2',
  )
}

const FILE_FOR_KIND: Readonly<Record<LicenseFileKind, string>> = {
  'third-party': THIRD_PARTY_LICENSE_TEXT,
  chromium: CHROMIUM_LICENSES_FILE,
  copse: COPSE_LICENSE_FILE,
}

export function licenseFilePath(kind: LicenseFileKind, dir: string = licensesDir()): string {
  return join(dir, FILE_FOR_KIND[kind])
}

/**
 * A path another application can open for `kind`. The Chromium notices ship
 * gzipped, so they are decompressed into `tempDir` first.
 */
export async function openableLicenseFile(
  kind: LicenseFileKind,
  tempDir: string,
  dir: string = licensesDir(),
): Promise<string> {
  const shipped = licenseFilePath(kind, dir)
  if (!shipped.endsWith('.gz')) return shipped
  const outDir = join(tempDir, 'copse-licenses')
  const out = join(outDir, basename(shipped, '.gz'))
  await mkdir(outDir, { recursive: true })
  // Write beside and rename, so a viewer never opens a half-written file.
  const partial = `${out}.${String(process.pid)}.partial`
  await pipeline(createReadStream(shipped), createGunzip(), createWriteStream(partial))
  await rename(partial, out)
  return out
}

const reportSchema = z.object({
  version: z.literal(THIRD_PARTY_LICENSE_REPORT_VERSION),
  components: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      license: z.string(),
      source: z.string().nullable(),
      shippedAs: z.array(z.enum(THIRD_PARTY_SHIPPED_AS)),
      partOf: z.string().nullable(),
      note: z.string().optional(),
      files: z.array(z.object({ name: z.string(), text: z.number().int().nonnegative() })),
    }),
  ),
  texts: z.array(z.string()),
})

const cache = new Map<string, Promise<ThirdPartyLicenseReport | null>>()

/**
 * The shipped report, or null when this build has none (a `pnpm dev` build that
 * never ran the full `pnpm build`). Read once: the file cannot change under a
 * running app.
 */
export function readThirdPartyLicenseReport(
  dir: string = licensesDir(),
): Promise<ThirdPartyLicenseReport | null> {
  let report = cache.get(dir)
  if (!report) {
    report = readFile(join(dir, THIRD_PARTY_LICENSE_JSON), 'utf8').then(
      (text) => safeJsonParse(text, decodeWithSchema(reportSchema)),
      () => null,
    )
    cache.set(dir, report)
  }
  return report
}
