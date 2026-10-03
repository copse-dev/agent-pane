import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'

const packageVersionSchema = z.object({ version: z.string().trim().min(1) })

interface AppVersionRuntime {
  isPackaged: boolean
  getVersion(): string
}

/**
 * An unpackaged run (`electron dist/main/index.js`) has no package.json beside
 * the entry point, so `app.getVersion()` reports Electron's own version. Read
 * Copse's from the source tree instead; packaged apps carry the right one.
 */
export async function getAppVersion(
  runtime: AppVersionRuntime,
  mainDir: string = __dirname,
): Promise<string> {
  if (runtime.isPackaged) return runtime.getVersion()
  try {
    const parsed = safeJsonParse(
      await readFile(join(mainDir, '../../package.json'), 'utf8'),
      decodeWithSchema(packageVersionSchema),
    )
    if (parsed !== null) return parsed.version
  } catch {
    // Source archive without package.json beside dist/: fall back below.
  }
  return runtime.getVersion()
}
