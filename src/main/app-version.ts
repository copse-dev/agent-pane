import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * An unpackaged run (`electron dist/main/index.js`) has no package.json beside
 * the entry point, so `app.getVersion()` reports Electron's own version. Read
 * Copse's from the source tree instead; packaged apps carry the right one.
 */
export function getAppVersion(): string {
  if (app.isPackaged) return app.getVersion()
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const { version } = parsed
      if (typeof version === 'string') return version
    }
  } catch {
    // Source archive without package.json beside dist/: fall back below.
  }
  return app.getVersion()
}
