import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { glob } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Source files have to stay text, because the tools that read the repo decide
 * that by sniffing for control bytes.
 *
 * `search_code` shells out to ripgrep (`services/search/indexed-grep.ts`) with
 * no `--text`, so ripgrep's binary detection applies: it stops reading a file at
 * the first NUL and reports nothing from it. One raw NUL in a template literal
 * therefore made `command-palette.ts` unsearchable by the product's own tool —
 * and by `grep`, and by every reviewer's editor — while `rg --files` still
 * listed it in the index, so it looked present and searched empty.
 *
 * Escapes (`\u0000`) are the fix: identical at runtime, ordinary text on disk.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..')

const SOURCE_GLOBS = [
  'src/**/*.ts',
  'src/**/*.tsx',
  'packages/*/src/**/*.ts',
  'scripts/**/*.mts',
  'scripts/**/*.ts',
  'tests/**/*.ts',
]

/** Control bytes no source file has a reason to carry raw: everything below space except tab/newline/CR, plus DEL. */
function controlBytes(bytes: Uint8Array): number[] {
  const found = new Set<number>()
  for (const byte of bytes) {
    if (byte === 9 || byte === 10 || byte === 13) continue
    if (byte < 32 || byte === 127) found.add(byte)
  }
  return [...found].sort((a, b) => a - b)
}

describe('source text invariants', () => {
  it('keeps every source file free of raw control bytes', async () => {
    const offenders: string[] = []
    let scanned = 0
    for (const pattern of SOURCE_GLOBS) {
      for await (const relative of glob(pattern, { cwd: REPO_ROOT })) {
        scanned += 1
        const bytes = await readFile(resolve(REPO_ROOT, relative))
        const found = controlBytes(bytes)
        if (found.length > 0) {
          offenders.push(
            `${relative.replace(/\\/g, '/')} contains ${found.map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}`,
          )
        }
      }
    }
    assert.ok(scanned > 100, `expected to scan the source tree, saw ${String(scanned)} files`)
    assert.deepEqual(
      offenders,
      [],
      'ripgrep skips a file at its first control byte, so these are invisible to search_code — write the character as an escape instead',
    )
  })
})
