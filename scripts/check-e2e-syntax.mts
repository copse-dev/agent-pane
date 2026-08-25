// Syntax gate for the e2e tree. tests/e2e is excluded from both tsconfigs and
// from eslint, so a typo in a spec otherwise only surfaces when wdio loads the
// file — after a full build and Electron launch. This parses every spec (and
// the wdio configs) with esbuild, which is the same transform wdio applies, so
// anything that would crash spec loading fails here in milliseconds instead.
//
// Deliberately NOT a typecheck: the directory has never been typechecked and
// making it so is its own cleanup project.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { transformSync } from 'esbuild'

function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else if (entry.endsWith('.ts')) files.push(full)
  }
  return files
}

const roots = [
  ...walk(join(process.cwd(), 'tests', 'e2e')),
  ...readdirSync(process.cwd())
    .filter((name) => /^wdio.*\.conf\.ts$/.test(name))
    .map((name) => join(process.cwd(), name)),
]

let failures = 0
for (const file of roots) {
  try {
    transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' })
  } catch (err) {
    failures += 1
    console.error(`✗ ${file}`)
    console.error(err instanceof Error ? err.message : String(err))
  }
}

if (failures > 0) {
  console.error(`\ncheck-e2e-syntax: ${String(failures)} file(s) failed to parse`)
  process.exit(1)
}
console.log(`check-e2e-syntax: ${String(roots.length)} files parsed cleanly`)
