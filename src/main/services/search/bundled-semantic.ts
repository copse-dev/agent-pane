import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

const GORTEX_BIN = process.platform === 'win32' ? 'gortex.exe' : 'gortex'

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
