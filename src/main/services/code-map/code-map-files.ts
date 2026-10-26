import { join } from 'node:path'
import * as fs from 'node:fs/promises'
import { buildIndex, getIndex } from '../search/file-index.ts'

export interface CodeMapFile {
  path: string
  content: string
}

// Mirror blockviz's own limits (vendor/blockviz/src/core/loaders.ts): it
// re-applies the exact same code-first/tests/docs ordering and caps to
// whatever it's handed, so reading past what it would keep is wasted I/O and
// a larger IPC payload than the diagram will ever use.
const MAX_FILE_BYTES = 2_000_000
const MAX_FILES = 4_000
const MAX_TOTAL_BYTES = 100_000_000
const BINARY_PROBE_BYTES = 8_192

// Mirrors `TEST_DIRS`/`DOC_DIRS`/`rank` in vendor/blockviz/src/core/loaders.ts,
// closely enough that truncating here (when a project exceeds the limits
// above) drops the same low-priority files blockviz's own ranking would.
const TEST_DIRS = new Set([
  'tests',
  'test',
  'testing',
  '__tests__',
  'spec',
  'specs',
  'e2e',
  '__mocks__',
  'test-d',
])
const DOC_DIRS = new Set(['docs', 'doc', 'documentation'])

function rank(path: string): number {
  const dirs = path.split('/').slice(0, -1)
  if (dirs.some((d) => DOC_DIRS.has(d))) return 2
  if (dirs.some((d) => TEST_DIRS.has(d)) || /\.(test|spec)\.|-spec\./.test(path)) return 1
  return 0
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_PROBE_BYTES).includes(0)
}

/**
 * The current project's text files, read from disk for the Code Map panel's
 * embedded blockviz loader. Builds on the same gitignore-aware listing
 * `find_files`/`search_code` use (file-index.ts) rather than walking the tree
 * again; blockviz's own `embeddedProject` is the authority on which files it
 * keeps, so this only needs to keep the read itself bounded.
 */
export async function collectProjectFiles(root: string): Promise<CodeMapFile[]> {
  await buildIndex(root)
  const paths = [...(getIndex(root)?.paths ?? [])].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  )

  const files: CodeMapFile[] = []
  let total = 0
  for (const path of paths) {
    if (files.length >= MAX_FILES || total >= MAX_TOTAL_BYTES) break
    let buf: Buffer
    try {
      const abs = join(root, path)
      const stat = await fs.stat(abs)
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) continue
      buf = await fs.readFile(abs)
    } catch {
      continue
    }
    if (looksBinary(buf)) continue
    total += buf.length
    files.push({ path, content: buf.toString('utf8') })
  }
  return files
}
