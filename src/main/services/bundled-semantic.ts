import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

const CODESEARCH_BIN = process.platform === 'win32' ? 'codesearch.exe' : 'codesearch'
const GORTEX_BIN = process.platform === 'win32' ? 'gortex.exe' : 'gortex'

/** Resolve a bundled codesearch binary shipped with copse-panel (vendor/ or dist/resources/). */
export function getBundledCodesearchPath(): string | null {
  return firstAccessible([
    join(__dirname, '../resources/codesearch', CODESEARCH_BIN),
    join(__dirname, '../../vendor/codesearch', CODESEARCH_BIN),
  ])
}

/** Resolve a bundled gortex binary shipped with copse-panel (vendor/ or dist/resources/). */
export function getBundledGortexPath(): string | null {
  return firstAccessible([
    join(__dirname, '../resources/gortex', GORTEX_BIN),
    join(__dirname, '../../vendor/gortex', GORTEX_BIN),
  ])
}

function firstAccessible(candidates: string[]): string | null {
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
