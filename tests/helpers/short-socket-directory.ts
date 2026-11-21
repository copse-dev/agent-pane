import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SuiteContext, TestContext } from 'node:test'

/** Leave room for a hashed socket filename and OpenSSH's bind-time suffix. */
export function shortSocketDirectory(t: SuiteContext | TestContext): string {
  if (!('after' in t)) throw new Error('Socket fixtures require a test cleanup context')
  for (const root of new Set([tmpdir(), '/tmp'])) {
    const directory = mkdtempSync(join(root, 'cs-'))
    if (Buffer.byteLength(directory, 'utf8') <= 60) {
      t.after(() => {
        rmSync(directory, { recursive: true, force: true })
      })
      return directory
    }
    rmSync(directory, { recursive: true, force: true })
  }
  throw new Error('No temporary directory fits the Unix socket path budget')
}
