import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

const CODESEARCH_BIN = process.platform === 'win32' ? 'codesearch.exe' : 'codesearch'

/** Resolve a bundled codesearch binary shipped with copse-panel (vendor/ or dist/resources/). */
export function getBundledCodesearchPath(): string | null {
  const candidates = [
    join(__dirname, '../resources/codesearch', CODESEARCH_BIN),
    join(__dirname, '../../vendor/codesearch', CODESEARCH_BIN),
  ]

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.F_OK)
      return candidate
    } catch {
      // try next candidate
    }
  }
  return null
}
