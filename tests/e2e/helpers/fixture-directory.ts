import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Isolate each fixture while keeping its displayed workspace basename stable. */
export function createFixtureDirectory(prefix: string): { root: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const root = join(parent, prefix)
  mkdirSync(root)
  return { root, cleanup: () => rmSync(parent, { recursive: true, force: true }) }
}
